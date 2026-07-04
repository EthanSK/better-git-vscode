import * as vscode from "vscode";

// NOTE: the old `isNavigationPromptOpen` guard + the getNextFileName/getPreviousFileName helpers were
// removed in v1.0.2 along with the cross-file confirmation prompt — the tool now ALWAYS jumps silently.

// ──────────────────────────────────────────────────────────────────────────────────────────
// LAST-STAGED STATUS BAR (v1.1.0)
//
// WHY this exists (Ethan's exact problem): he reviews AI-generated changesets file-by-file from the
// keyboard. stage-and-next-changed-file (shift+alt+. on QWERTY, shift+alt+v in Dvorak mode) stages the current file and IMMEDIATELY jumps
// to the next one. He keeps "accidentally staging a file without noticing" — he wasn't looking, or it
// advanced instantly — and then has no record of what just got staged. This persistent bottom-bar
// indicator shows the LAST file staged via the extension so he can "go back and remember" what was
// staged and undo it if it was a mistake.
//
// These are MODULE-LEVEL (not inside activate) so the staging helpers below — which are module-scope
// arrow functions, not closures over activate — can update them, and so the click-command can read the
// stored URI. The StatusBarItem itself is created in activate() and pushed to context.subscriptions for
// clean disposal; we keep a module reference so recordLastStaged() can mutate it from anywhere.
let lastStagedStatusBarItem: vscode.StatusBarItem | undefined; // the bottom-bar item; undefined before activate()
let lastStagedUri: vscode.Uri | undefined; // file: URI of the most recent file staged THROUGH this extension

// Reads the live setting that gates the whole feature. Read at update time (not cached) so toggling it
// in Settings takes effect on the next stage without any restart; activate() ALSO wires an
// onDidChangeConfiguration listener so flipping it OFF hides the item immediately (and ON re-shows it).
const showLastStagedEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("showLastStagedInStatusBar", true);

// Records `uri` as the last-staged file and refreshes the status bar item. Called from the SINGLE stage
// chokepoint (stageThroughExtension) so EVERY stage path the extension performs updates the indicator —
// a future stage path physically cannot bypass it as long as it stages via that helper. We show the
// basename only (the bar must stay compact) and put the full workspace-relative path in the tooltip.
const recordLastStaged = (uri: vscode.Uri): void => {
    lastStagedUri = uri; // always remember it, even if the bar is currently hidden by the setting
    if (!lastStagedStatusBarItem || !showLastStagedEnabled()) {
        return; // item not created yet (pre-activate) or feature disabled -> never show
    }
    const basename = uri.path.split("/").pop() ?? uri.fsPath; // bar text: just the file name, keep it short
    const relPath = vscode.workspace.asRelativePath(uri); // tooltip: workspace-relative full path for context
    lastStagedStatusBarItem.text = `$(check) Staged: ${basename}`; // $(check) renders VS Code's codicon checkmark
    lastStagedStatusBarItem.tooltip = `${relPath}\nLast file staged via Better Git — click to reopen its diff`;
    lastStagedStatusBarItem.show(); // persists for the rest of the session (the whole point: a lasting record)
};

// THE SINGLE STAGE CHOKEPOINT. Every place the extension stages a file routes through here: it runs the
// actual `git add` (same as clicking the + in Source Control) and ONLY records the last-staged file if the
// add() resolved without throwing. Because the await rethrows on failure, a stage that errored (or had
// nothing to stage) never updates the indicator — so the bar never shows a file that wasn't actually
// staged. Capture the staged URI here, BEFORE callers advance the active editor, so we record the file we
// staged rather than whatever the editor switches to after the jump.
const stageThroughExtension = async (repo: any, uri: vscode.Uri): Promise<void> => {
    await repo.add([uri.fsPath]); // the real stage; throws -> recordLastStaged below is skipped
    recordLastStaged(uri); // success -> update the status bar with the file we just staged
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// COLLAPSE WORKTREES / REPOSITORY SECTIONS ON STARTUP (v1.2.2)
//
// WHY this exists (Ethan's exact request): he works with git WORKTREES (e.g.
// ~/Documents/claude-worktrees/<project>-<name>). When multiple worktrees / repositories are open in
// one window, VS Code's built-in Source Control view renders EACH repository as its own collapsible
// section header. On every window open / reload those sections all render EXPANDED — noisy when you
// have several worktrees. He wants them collapsed by default so the SCM panel stays tidy.
//
// HOW we do it — the ONLY reliable command that exists (verified against the shipped VS Code bundle,
// src/vs/workbench/contrib/scm/):
//   `workbench.scm.action.collapseAllRepositories`
// Its handler literally iterates `scmViewService.visibleRepositories` and collapses every collapsible
// one (the repo/worktree section headers) — exactly the annoyance. There is NO public extension API to
// PERSIST or DEFAULT the SCM repository collapse state (no `scm.defaultViewMode`-style setting for repo
// headers), so calling this command on startup is the closest available workaround. (There is also a
// generic `workbench.scm.action.collapseAll` which collapses resource GROUPS inside a repo, not the repo
// headers — not what we want. `git.collapseAll` does not exist.)
//
// CRITICAL CAVEAT #1 — the command is a VIEW ACTION: its handler resolves the target view via
// `getActiveViewWithId("workbench.scm")`, which only returns the view when the Source Control viewlet is
// the ACTIVE (currently-open) sidebar container. If SCM isn't the active view, the command silently
// no-ops. So we MUST reveal SCM first (`workbench.view.scm`) and only THEN collapse. This does bring the
// Source Control panel to the foreground — acceptable here because this whole extension is a git-diff
// review tool and Ethan is looking at worktree changes on reload anyway; and we only auto-run it when
// there are actually ≥2 repositories (the multi-worktree annoyance), so a single-repo window is left
// untouched and unfocused.
//
// CRITICAL CAVEAT #2 — TIMING / POPULATE: the git extension discovers repositories asynchronously after
// window load, and the SCM tree must have the repo nodes present before there's anything to collapse.
// So the startup path POLLS the git API until repositories appear (or a timeout), then collapses; and it
// also listens (briefly, only during a startup window) for late-appearing worktrees so those get
// collapsed too. All best-effort and wrapped in try/catch — if the command doesn't exist on an old host,
// or the git API isn't ready, we no-op safely and never break activation.

// The built-in command id that collapses all SCM repository/worktree section headers. Kept as a const so
// there's a single source of truth and it's easy to find/grep.
const SCM_COLLAPSE_ALL_REPOS_COMMAND = "workbench.scm.action.collapseAllRepositories";

// Reveal the Source Control view (required — see CAVEAT #1) then run the collapse-all-repositories
// command. Returns true if the collapse command was dispatched without throwing. Fully defensive: any
// failure (command missing on an old host, view not resolvable) is swallowed so it can never break
// startup or a manual invocation.
//
// NOTE: this is the LOW-LEVEL primitive — it collapses EVERY repository/worktree header, INCLUDING the
// primary/main one. The user-facing behaviour (keep the primary expanded, collapse only the OTHER
// worktrees) is layered on top in collapseWorktreesKeepingPrimaryExpanded() below, which calls this and
// then re-expands just the primary. Kept separate so the "collapse all" step has a single definition.
const collapseScmRepositories = async (): Promise<boolean> => {
    try {
        // Must make SCM the active sidebar container first, otherwise the view action can't resolve its
        // target view and no-ops. This focuses the Source Control panel.
        await vscode.commands.executeCommand("workbench.view.scm");
        // Now the collapse command has a live view to act on — collapses every repo/worktree header.
        await vscode.commands.executeCommand(SCM_COLLAPSE_ALL_REPOS_COMMAND);
        return true;
    } catch {
        // Old VS Code without this command id, or the view wasn't resolvable — do nothing, safely.
        return false;
    }
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// KEEP THE PRIMARY / MAIN REPO EXPANDED, COLLAPSE ONLY THE OTHER WORKTREES (v1.2.4)
//
// WHY (Ethan's exact request): the repository at the TOP of the Source Control view is his main working
// copy — the one he's actively working in — and should stay EXPANDED. Only the ADDITIONAL linked worktrees
// below it (e.g. ~/Documents/claude-worktrees/<project>-<name>) should fold away.
//
// THE API LIMITATION (verified against the shipped VS Code bundle, src/vs/workbench/contrib/scm/):
// there is NO command that collapses (or expands) a SINGLE, specific repository. The only two repo-level
// commands both operate on ALL of them at once:
//   • workbench.scm.action.collapseAllRepositories — iterates scmViewService.visibleRepositories, collapses each
//   • workbench.scm.action.expandAllRepositories   — same, but expands each
// The per-node tree.collapse()/tree.expand() calls those wrap are INTERNAL to the SCM view and unreachable
// from an extension. So "collapse all except the primary" is not directly expressible.
//
// HOW WE ACHIEVE IT ANYWAY — collapse everything, then RE-EXPAND just the primary via SCM auto-reveal:
// the Source Control view has a built-in behaviour, `scm.autoReveal` (default ON), whose handler is
// SCMView.onDidActiveEditorChange. When the active editor changes, it looks up the SCM resource whose
// sourceUri matches the editor's file and calls `tree.expandTo(resource)` — which expands ALL ancestor
// nodes of that resource, INCLUDING its repository/worktree header. (Confirmed in the bundle:
// `await this.tree.expandTo(s); this.tree.reveal(s); ...`.) So if, right after collapsing all repos, we
// make a file that belongs to the PRIMARY repo the active editor, the SCM view re-expands the primary's
// header for us — and leaves every other worktree collapsed. This is model-driven (keys off the active
// editor + the repo's own change list), which makes it far more deterministic than trying to drive the
// tree's transient keyboard focus with list.* commands.
//
// HONEST LIMITATIONS (documented, not faked):
//   1. It relies on `scm.autoReveal` being enabled (VS Code default true). If the user turned it off, we
//      skip the re-expand — the primary stays collapsed like the rest. We check the setting and bail cleanly.
//   2. To trigger auto-reveal we OPEN one of the primary repo's changed files in a PREVIEW tab (preview +
//      preserveFocus, so keyboard focus stays on the Source Control panel and no pinned tab is disturbed).
//      That is a visible side effect: on reload, the primary repo's first change is shown. For a git-diff
//      REVIEW tool that's a reasonable landing spot, but it IS an extra tab — the tradeoff of the missing
//      "expand one repo" API.
//   3. If the primary repo has NO changes at all, there's no resource to reveal, so it stays collapsed
//      (nothing to expand toward). Not a problem in practice — an unchanged primary has nothing to review.
//   4. Timing still applies: the repos must have populated (handled by the startup poll below).

// Case-insensitive (mac/win filesystems) comparison of two uris' on-disk roots, trailing separators
// stripped, so a repo's rootUri can be matched against a workspace folder uri regardless of a trailing slash.
const sameRootPath = (a: vscode.Uri, b: vscode.Uri): boolean =>
    a.fsPath.replace(/[\/\\]+$/, "").toLowerCase() === b.fsPath.replace(/[\/\\]+$/, "").toLowerCase();

// Identify the PRIMARY / main repository — the workspace's main working copy, the one that renders at the
// TOP of the Source Control view. Robust detection: it's the repo whose rootUri equals the FIRST workspace
// folder (vscode.workspace.workspaceFolders[0]). Linked worktrees live OUTSIDE the workspace folder (their
// rootUri points elsewhere, e.g. ~/Documents/claude-worktrees/…), so they won't match folder[0]. If that
// can't be resolved (no folders, or none matches — e.g. the main repo root isn't itself a workspace folder),
// fall back to git.repositories[0], the first repository the git extension discovered, which is the closest
// available "primary" proxy. Returns undefined only when there are no repositories at all.
const getPrimaryRepository = (): any | undefined => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repos: any[] = git?.repositories ?? [];
        if (repos.length === 0) {
            return undefined;
        }
        const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (firstFolder) {
            // The main working copy's root == the primary workspace folder. Match on that.
            const match = repos.find((r) => r?.rootUri && sameRootPath(r.rootUri as vscode.Uri, firstFolder));
            if (match) {
                return match;
            }
        }
        return repos[0]; // fallback: first-discovered repo is the closest proxy for "primary"
    } catch {
        return undefined; // git API not ready / shape changed — caller treats undefined as "can't re-expand"
    }
};

// Pick a file: uri belonging to `repo` that we can open to trigger SCM auto-reveal (which then re-expands
// that repo's header). We prefer a working-tree change (on-disk, always openable), then an untracked file,
// then a merge-conflict file, then a staged (index) change. We deliberately try working-tree/untracked
// FIRST because a staged entry could be a staged DELETION whose file no longer exists on disk (showTextDocument
// would throw — harmless, we catch it, but it's a wasted attempt). Returns the change's `.uri` (the working
// file path), which is exactly the `sourceUri` the SCM auto-reveal matcher compares against.
const firstOpenableChangeUri = (repo: any): vscode.Uri | undefined => {
    // Order matters: working-tree + untracked are real on-disk files; index/merge are best-effort fallbacks.
    const groups: any[][] = [
        repo?.state?.workingTreeChanges ?? [],
        repo?.state?.untrackedChanges ?? [],
        repo?.state?.mergeChanges ?? [],
        repo?.state?.indexChanges ?? [],
    ];
    for (const group of groups) {
        const first = group[0];
        if (first?.uri) {
            return first.uri as vscode.Uri;
        }
    }
    return undefined;
};

// THE user-facing behaviour: collapse every repository/worktree header, then re-expand ONLY the primary.
// Used by BOTH the startup auto-collapse and the manual command, because Ethan always wants the main repo
// he's working in left open. See the big comment block above for the mechanism + honest limitations.
const collapseWorktreesKeepingPrimaryExpanded = async (): Promise<void> => {
    // Step 1 — collapse ALL repo headers (this also collapses the primary; we re-open it in step 2).
    const collapsed = await collapseScmRepositories();
    if (!collapsed) {
        return; // collapse command unavailable / view not resolvable — nothing more we can do
    }

    // Step 2 — re-expand just the primary by nudging SCM auto-reveal onto one of its changed files.
    const primary = getPrimaryRepository();
    if (!primary) {
        return; // no repositories — nothing to keep expanded
    }
    // If the user disabled scm.autoReveal, the expandTo mechanism won't fire — honestly bail (primary stays
    // collapsed with the rest) rather than pretend. This is limitation #1 in the block above.
    const autoRevealOn = vscode.workspace.getConfiguration("scm").get<boolean>("autoReveal", true);
    if (!autoRevealOn) {
        return;
    }
    const revealUri = firstOpenableChangeUri(primary);
    if (!revealUri) {
        return; // primary has no changes -> no resource to reveal toward -> leave it collapsed (limitation #3)
    }
    try {
        // Let the collapse settle on the SCM view's internal tree-operation sequencer before we queue the
        // reveal, so the expandTo from auto-reveal lands AFTER the collapse (otherwise a race could collapse
        // the primary right back). A short delay is enough — both run on the same microtask-ish queue.
        await new Promise((r) => setTimeout(r, 120));
        // Open a primary-repo change as the ACTIVE editor to fire SCMView.onDidActiveEditorChange -> expandTo.
        // preview:true reuses the ephemeral preview tab (doesn't pile up pinned tabs); preserveFocus:true keeps
        // keyboard focus on the Source Control panel we just revealed, so the user isn't yanked into the editor.
        await vscode.window.showTextDocument(revealUri, { preview: true, preserveFocus: true });
    } catch {
        // File couldn't be opened (e.g. a staged deletion we fell through to) — the primary just stays
        // collapsed. Never throw: this must not break startup or a manual invocation.
    }
};

// Reads the git API and returns how many repositories/worktrees VS Code currently has open (0 if the git
// extension isn't ready yet). Used to (a) decide whether the multi-worktree annoyance even applies and
// (b) poll until repos have populated before collapsing.
const getOpenRepositoryCount = (): number => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        return git?.repositories?.length ?? 0;
    } catch {
        return 0; // git extension not present / API shape changed — treat as "no repos"
    }
};

// The auto-on-startup routine. Gated by the `collapseWorktreesOnStartup` setting (default true) and by
// there being ≥2 repositories (a single repo isn't the "lots of expanded worktrees" annoyance, and we
// don't want to steal focus / hide the only repo's changes for it). Because repos populate async, we
// POLL for them, then collapse. We ALSO briefly watch `onDidOpenRepository` so worktrees that finish
// opening AFTER our first collapse still get folded — but only within a short startup window, so opening
// a repo later in the session (deliberately) never yanks its section closed under the user.
const runCollapseWorktreesOnStartup = (context: vscode.ExtensionContext): void => {
    const enabled = vscode.workspace
        .getConfiguration("better-git-vscode")
        .get<boolean>("collapseWorktreesOnStartup", true);
    if (!enabled) {
        return; // user opted out — never auto-collapse, but the manual command still works
    }

    let done = false; // guard so we collapse at most once from the poll loop
    const MIN_REPOS_TO_COLLAPSE = 2; // only the multi-worktree case; leave single-repo windows alone
    const POLL_INTERVAL_MS = 400; // how often to re-check for populated repos
    const MAX_POLLS = 25; // ~10s ceiling — enough for git to discover worktrees on a cold reload

    // Poll until repos have populated (≥2), then collapse once. If they never reach 2 within the window we
    // simply give up (a 0/1-repo window has no worktree pile-up to tidy).
    let polls = 0;
    const timer = setInterval(async () => {
        polls++;
        if (done) {
            clearInterval(timer);
            return;
        }
        if (getOpenRepositoryCount() >= MIN_REPOS_TO_COLLAPSE) {
            done = true;
            clearInterval(timer);
            // Collapse the OTHER worktrees but keep the primary/main repo expanded (v1.2.4).
            await collapseWorktreesKeepingPrimaryExpanded();
        } else if (polls >= MAX_POLLS) {
            clearInterval(timer); // timed out — no multi-worktree situation, nothing to do
        }
    }, POLL_INTERVAL_MS);
    // Make sure the poll timer is torn down if the extension deactivates mid-poll.
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

    // Startup window listener: worktrees that open shortly AFTER the first collapse (git discovers repos
    // in waves) should also be folded. We only honour this for a short window after activation so that
    // opening a repo deliberately later in the session isn't collapsed out from under the user.
    const STARTUP_WINDOW_MS = 12000; // re-collapse late worktrees for ~12s after activation, then stop
    const activatedAt = Date.now();
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        if (git?.onDidOpenRepository) {
            let reCollapseTimer: ReturnType<typeof setTimeout> | undefined;
            const sub = git.onDidOpenRepository(() => {
                if (Date.now() - activatedAt > STARTUP_WINDOW_MS) {
                    return; // past the startup window — respect the user's manual repo opens
                }
                // Debounce: several worktrees can open in the same tick; collapse once after they settle.
                if (reCollapseTimer) {
                    clearTimeout(reCollapseTimer);
                }
                reCollapseTimer = setTimeout(() => {
                    // Late worktree opened -> re-fold the others, still keeping the primary expanded (v1.2.4).
                    void collapseWorktreesKeepingPrimaryExpanded();
                }, 600);
            });
            context.subscriptions.push(sub);
        }
    } catch {
        // git API not available / different shape — the poll loop above is the primary path anyway.
    }
};

export function activate(context: vscode.ExtensionContext) {
    // Create the last-staged status bar item. Left alignment + priority 100 puts it on the left cluster at a
    // reasonable position. Starts HIDDEN — there's nothing to show until the first stage of the session. Its
    // .command points at our reveal command (registered below) so a click reopens the staged file's diff.
    lastStagedStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    lastStagedStatusBarItem.command = "better-git-vscode.reveal-last-staged-file";
    lastStagedStatusBarItem.hide();
    let disposable = vscode.commands.registerCommand("better-git-vscode.next-scm-change", async () => {
        await goToNextDiff();
    });

    let disposable2 = vscode.commands.registerCommand("better-git-vscode.previous-scm-change", async () => {
        await goToPreviousDiff();
    });

    let disposable3 = vscode.commands.registerCommand("better-git-vscode.next-changed-file", async () => {
        await goToFirstOrNextFile();
    });

    let disposable4 = vscode.commands.registerCommand("better-git-vscode.previous-changed-file", async () => {
        await goToLastOrPreviousFile();
    });

    let disposable5 = vscode.commands.registerCommand("better-git-vscode.revert-and-save", async () => {
        await vscode.commands.executeCommand("git.revertSelectedRanges");
        await vscode.commands.executeCommand("workbench.action.files.save");
    });

    let disposable6 = vscode.commands.registerCommand("better-git-vscode.stage-and-next-changed-file", async () => {
        await stageCurrentFileAndAdvance("next");
    });

    // Mirror of disposable6 for reverse-order (bottom-to-top) review: stage the current file, then jump to the
    // PREVIOUS unstaged file instead of the next. Bound to "shift + previous" so it parallels "shift + next".
    let disposable7 = vscode.commands.registerCommand("better-git-vscode.stage-and-previous-changed-file", async () => {
        await stageCurrentFileAndAdvance("previous");
    });

    // Editor-title button (top-right of the editor, next to the built-in diff/open icons): stage the current
    // file WITHOUT navigating. Contributed to the editor/title menu in package.json so it renders as an icon.
    let disposable8 = vscode.commands.registerCommand("better-git-vscode.stage-current-file", async () => {
        await stageCurrentFile();
    });

    // Manual trigger for collapsing the worktree/repository section headers (see the big comment block
    // above `activate`). Ethan can bind this to a key or run it from the palette any time the worktree
    // sections have crept back open. Like the startup path it keeps the PRIMARY/main repo expanded (v1.2.4)
    // and folds only the other worktrees — that matches his intent (always leave the one he's working in
    // open). Unlike the auto-on-startup path this has NO ≥2-repo gate — if you ask for it explicitly, we
    // act on whatever's there.
    let disposable14 = vscode.commands.registerCommand("better-git-vscode.collapse-worktrees", async () => {
        await collapseWorktreesKeepingPrimaryExpanded();
    });

    // ──────────────────────────────────────────────────────────────────────────────────────────
    // SMART MOUSE-BUTTON COMMANDS (smart-forward / smart-back)
    //
    // These are bound to Ethan's mouse Forward/Back buttons (via Karabiner -> F13/F17 -> these
    // commands). MOUSE-ONLY since v1.2.5: they used to ALSO hold the default QWERTY keyboard keys
    // alt+. / alt+, (the physical >/< keys), which silently inherited the intentional mouse-direction
    // flip below (commit 6043d05) — so on QWERTY keyboards ">" went BACKWARD through diff changes and
    // "<" went FORWARD, while Dvorak keyboards were fine (their physical >/< type v/w, which hit
    // next/previous-scm-change directly). v1.2.5 gave the QWERTY >/< keys back to the canonical
    // next/previous-scm-change commands (see _comment_dvorakMode_keybindings in package.json); these
    // smart commands now have no default QWERTY keyboard binding (alt+./alt+, remain only under
    // dvorakMode, where those characters live on different physical keys, to keep Ethan's working
    // Dvorak setup untouched). They give ONE pair of buttons a dual meaning depending on what's on screen:
    //   - When a side-by-side DIFF editor is the active tab  -> next/previous SCM change (review flow)
    //   - Anywhere else                                      -> classic editor back/forward navigation
    //
    // WHY we detect the diff via the TAB INPUT TYPE here, NOT via the `isInDiffEditor` keybinding context:
    //   The previous approach gated the mouse keys in keybindings.json with `when: isInDiffEditor` /
    //   `when: !isInDiffEditor`. That CONTEXT key is only true when the diff editor is the *focused/active*
    //   editor. In Ethan's review flow, keyboard focus is frequently in the Source Control panel (he's
    //   clicking files there) while the diff is merely VISIBLE in the editor area — so `isInDiffEditor`
    //   reads FALSE and the mouse button wrongly fell back to plain back/forward navigation mid-review.
    //   `vscode.window.tabGroups.activeTabGroup.activeTab` is FOCUS-INDEPENDENT: it tells us what tab is
    //   open in the active group regardless of whether focus is in the editor, the SCM panel, the terminal,
    //   etc. `tab.input instanceof vscode.TabInputTextDiff` is the canonical, stable way to ask "is the
    //   active tab a side-by-side text diff?" — exactly the situation where the mouse buttons should mean
    //   "next/previous change". We bake the decision into the extension so the keybindings can be
    //   UNCONDITIONAL (no flaky `when` clause).
    //
    // We REUSE the existing scm-change commands via executeCommand so there's a single source of truth for
    // the navigation logic (no duplication of goToNextDiff/goToPreviousDiff).
    //
    // Robustness: everything is wrapped in try/catch. TabInputTextDiff has been a stable VS Code API for
    // years (since ~1.67), but if it's ever unavailable (very old host) the `instanceof` check simply
    // evaluates false and we fall back to plain navigation — a safe default. Any unexpected throw also
    // falls back to plain navigation so a mouse click never becomes a no-op.
    let disposable9 = vscode.commands.registerCommand("better-git-vscode.smart-forward", async () => {
        await smartNavigate("forward");
    });
    let disposable10 = vscode.commands.registerCommand("better-git-vscode.smart-back", async () => {
        await smartNavigate("back");
    });

    // Reveal the current file in the Explorer — works even from a STAGED diff, where VS Code's built-in
    // "Reveal in Explorer" silently does nothing. WHY it's broken natively: the staged side of a diff is a
    // read-only git:-scheme VIRTUAL document (the index blob) with no node in the file:-based Explorer tree,
    // so reveal has nothing to select (open upstream bug: microsoft/vscode#240657). getActiveFileUri already
    // resolves that git: uri back to the on-disk file: uri (via the git: query's {path}), and revealInExplorer
    // is a supported command that reveals any file: uri (microsoft/vscode#94720). So we resolve, then reveal
    // THAT. Bind to cmd+shift+e (when: isInDiffEditor) to make reveal work from staged diffs. Works from
    // unstaged diffs and plain editors too (getActiveFileUri handles all three).
    let disposable11 = vscode.commands.registerCommand("better-git-vscode.reveal-current-file-in-explorer", async () => {
        // Capture the cursor + scroll position of the diff you're viewing FIRST (synchronously, before any
        // await), so the working file can open at the SAME spot instead of jumping to the top.
        // vscode.window.activeTextEditor is the diff's focused side: selection.active is the cursor,
        // visibleRanges[0].start is the top visible line.
        const src = vscode.window.activeTextEditor;
        const cursor = src?.selection.active;
        const topLine = src?.visibleRanges && src.visibleRanges.length > 0 ? src.visibleRanges[0].start.line : undefined;

        const uri = await getActiveFileUri();
        if (!uri) {
            return;
        }
        // Reveal/select in the Explorer, then OPEN the real working-tree file in a normal editor (reveal alone
        // only highlights the tree node; this opens the editable on-disk file so you don't press Space/Enter).
        await vscode.commands.executeCommand("revealInExplorer", uri);
        const editor = await vscode.window.showTextDocument(uri, { preview: false });

        // Restore cursor + scroll. Clamp to the working file's length: a partially-staged file's index content
        // can differ from the working tree, so the diff's line/column might not exist on disk.
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        if (cursor) {
            const line = Math.min(cursor.line, lastLine);
            const ch = Math.min(cursor.character, editor.document.lineAt(line).text.length);
            const pos = new vscode.Position(line, ch);
            editor.selection = new vscode.Selection(pos, pos);
        }
        if (topLine !== undefined) {
            const top = Math.min(topLine, lastLine);
            editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop); // match scroll: same top line
        } else if (cursor) {
            editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    });

    // MIRROR IMAGE of disposable11: that command goes diff -> working file at the same spot; THIS one goes
    // working file -> diff at the same spot. You're editing a file in a normal editor, hit this, and the
    // side-by-side "changes" view opens scrolled to the EXACT cursor + top line you were just looking at
    // (instead of git.openChange's default of jumping to the first change in the file). Bind it yourself in
    // keybindings.json — we intentionally ship NO default key for this one.
    let disposable12 = vscode.commands.registerCommand("better-git-vscode.open-change-at-position", async () => {
        // CAPTURE BEFORE OPENING THE DIFF. This is critical: git.openChange swaps the active editor to the
        // diff and typically moves the cursor to the file's first change — so if we read selection/scroll
        // AFTER the call we'd get the diff's position, not the working-file position we actually want to mirror.
        const src = vscode.window.activeTextEditor;
        if (!src) {
            return; // no active editor -> nothing to mirror, bail
        }
        const cursor = src.selection.active; // the cursor we want to reapply on the diff's right side
        const topLine = src.visibleRanges?.length ? src.visibleRanges[0].start.line : undefined; // top visible line (scroll)

        // Open the built-in "Open Changes" side-by-side diff for the active file (same as the SCM gutter/title
        // "Open Changes" action). This is what changes the active editor out from under us — hence the capture above.
        await vscode.commands.executeCommand("git.openChange");

        // DETECT THE DIFF + TIMING. We CANNOT detect the switch by uri: after git.openChange the diff's
        // MODIFIED (right) side is the SAME working file, so vscode.window.activeTextEditor.document.uri is
        // unchanged from before — a uri compare would always say "no switch happened". Instead we detect the
        // diff by the active TAB's input type: vscode.TabInputTextDiff means a side-by-side text diff tab is
        // active (the same focus-independent check the smart-mouse + badge code uses elsewhere in this file).
        // The switch is NOT guaranteed synchronous (git.openChange resolves the diff content asynchronously),
        // so we POLL: up to ~600ms in ~50ms steps, waiting until BOTH the active tab is a TabInputTextDiff AND
        // there's an activeTextEditor to apply the position to. If it never becomes a diff within the timeout
        // (e.g. an untracked/new file opens as a plain editor via vscode.open, not vscode.diff), we just fall
        // through and apply to whatever the active editor is — best-effort, never a no-op.
        const deadline = Date.now() + 600; // ~600ms total budget
        while (Date.now() < deadline) {
            const isDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff;
            if (isDiff && vscode.window.activeTextEditor) {
                break; // diff is up and we have an editor to position — stop polling
            }
            await new Promise((r) => setTimeout(r, 50)); // wait one ~50ms tick before re-checking
        }

        // Apply the captured position to the diff's right side (the now-active editor). SAME clamping logic as
        // disposable11: a file's diff side can differ in length from what we captured, so clamp the line to the
        // document's last line and the character to that line's length to avoid an out-of-range Position throw.
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return; // diff never produced an editor (e.g. binary) -> nothing to position, bail
        }
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const line = Math.min(cursor.line, lastLine);
        const ch = Math.min(cursor.character, editor.document.lineAt(line).text.length);
        const pos = new vscode.Position(line, ch);
        editor.selection = new vscode.Selection(pos, pos);
        if (topLine !== undefined) {
            const top = Math.min(topLine, lastLine);
            editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop); // match scroll: same top line
        }
    });

    // OVERLAY (supported API, no patching): badge the file currently open as a diff with a "▶" marker via a
    // FileDecorationProvider. The badge renders on the row in the built-in Source Control panel (and the
    // Explorer/tabs), giving a "you are here" indicator on the real Git rows. Caveat: decorations key on the
    // file URI, so a partially-staged (dual-state) file gets the badge on BOTH its staged and unstaged rows.
    const reviewDecoEmitter = new vscode.EventEmitter<vscode.Uri[]>();
    let currentReviewUri: vscode.Uri | undefined; // file: URI of the file currently shown as a diff
    const reviewDecorationProvider: vscode.FileDecorationProvider = {
        onDidChangeFileDecorations: reviewDecoEmitter.event,
        provideFileDecoration(uri) {
            if (currentReviewUri && uri.path.toLowerCase() === currentReviewUri.path.toLowerCase()) {
                // Badge text is configurable (default a colorful emoji for maximum visibility). The Source
                // Control panel ignores decoration `color` (its renderer forces colors:false), so the emoji's
                // own color is what makes it pop there; the `color` still applies in the Explorer + editor tabs.
                // Default badge is double fire 🔥🔥 (Ethan's preferred default; still user-overridable via the
                // better-git-vscode.currentFileBadge setting). The package.json config default MUST match this literal.
                const badgeSetting = vscode.workspace.getConfiguration("better-git-vscode").get<string>("currentFileBadge", "🔥🔥");
                if (!badgeSetting) {
                    return undefined; // empty setting => badge disabled
                }
                // VS Code caps the badge at 2 GRAPHEMES and drops the whole decoration if it's longer, so take
                // the first two graphemes. Intl.Segmenter keeps multi-codepoint emoji intact — a naive
                // slice(0,2) would cut a two-emoji badge like "🔥🔥" down to one (each emoji is 2 UTF-16 units).
                let badge = badgeSetting;
                try {
                    // (Intl as any): Intl.Segmenter may not be in the project's TS lib types, but it exists at runtime.
                    const seg = new (Intl as any).Segmenter(undefined, { granularity: "grapheme" });
                    badge = [...seg.segment(badgeSetting)].slice(0, 2).map((s: any) => s.segment).join("");
                } catch {
                    badge = Array.from(badgeSetting).slice(0, 2).join(""); // fallback by code point if Segmenter is unavailable
                }
                return { badge, tooltip: "Better Git VS Code: reviewing this file", color: new vscode.ThemeColor("charts.blue"), propagate: false };
            }
            return undefined;
        },
    };
    // Recompute the current review file whenever the active editor/tab changes, and refresh the decoration
    // for both the old and new file so the badge moves with you.
    const refreshReviewDecoration = () => {
        const prev = currentReviewUri;
        currentReviewUri = currentReviewFileUri();
        const changed: vscode.Uri[] = [];
        if (prev) {
            changed.push(prev);
        }
        if (currentReviewUri && (!prev || prev.path.toLowerCase() !== currentReviewUri.path.toLowerCase())) {
            changed.push(currentReviewUri);
        }
        if (changed.length > 0) {
            reviewDecoEmitter.fire(changed);
        }
    };

    // CLICK TARGET for the status bar item: reopen the diff of the last file staged via the extension, so
    // Ethan can review it and unstage it if it was an accident. We REUSE the extension's existing diff
    // machinery rather than re-deriving diff sides: getFileChanges() builds the same staged/unstaged list the
    // navigation uses, and openChangeEntry() already knows how to open the correct HEAD↔index diff for any
    // staged status (incl. the INDEX_ADDED/INDEX_DELETED "file not found" cases — see openChangeEntry). So we
    // look up the STAGED entry for lastStagedUri in that list and hand it to openChangeEntry. There is NO
    // extension API to focus a Source Control row, hence opening the diff (which is what lets him unstage) is
    // the most useful click action. Internal command (registered, but contributed with no keybinding).
    let disposable13 = vscode.commands.registerCommand("better-git-vscode.reveal-last-staged-file", async () => {
        if (!lastStagedUri) {
            return; // nothing staged via the extension yet this session
        }
        const target = lastStagedUri.path.toLowerCase();
        const fileChanges = await getFileChanges();
        // Prefer the STAGED (index) entry — that's the diff that shows what got staged and lets him unstage it.
        const stagedEntry = fileChanges.find((c) => c.staged && c.uri.path.toLowerCase() === target);
        if (stagedEntry) {
            await openChangeEntry(stagedEntry);
            return;
        }
        // Fallback: the file may no longer be staged (already committed, or unstaged again since), so it's not
        // in the staged group anymore. Just open the on-disk file so the click is never a dead no-op.
        try {
            await vscode.window.showTextDocument(lastStagedUri, { preview: true });
        } catch {
            // File gone (e.g. it was a staged deletion that got committed) — nothing sensible to open; ignore.
        }
    });

    // Live-react to the feature toggle: flipping better-git-vscode.showLastStagedInStatusBar OFF hides the
    // item immediately; flipping it back ON re-shows the current last-staged file (if any) without waiting for
    // the next stage. We react live (rather than only reading at update time) so the bar disappears the moment
    // Ethan unchecks the setting — less surprising than it lingering until the next stage.
    let configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("better-git-vscode.showLastStagedInStatusBar") || !lastStagedStatusBarItem) {
            return;
        }
        if (showLastStagedEnabled() && lastStagedUri) {
            recordLastStaged(lastStagedUri); // re-render + show with the file we last staged
        } else {
            lastStagedStatusBarItem.hide();
        }
    });

    // Kick off the collapse-worktrees-on-startup routine (gated by setting + ≥2 repos). This is async and
    // self-tearing-down; it does NOT block activation. See the big comment block above `activate` for the
    // timing/populate + reveal-SCM caveats.
    runCollapseWorktreesOnStartup(context);

    context.subscriptions.push(
        disposable, disposable2, disposable3, disposable4, disposable5, disposable6, disposable7, disposable8,
        disposable9, disposable10, disposable11, disposable12, disposable13, disposable14,
        lastStagedStatusBarItem, // disposed cleanly on deactivate
        configListener,
        reviewDecoEmitter,
        vscode.window.registerFileDecorationProvider(reviewDecorationProvider),
        vscode.window.tabGroups.onDidChangeTabs(() => refreshReviewDecoration()),
        vscode.window.onDidChangeActiveTextEditor(() => refreshReviewDecoration())
    );
}

// Returns the on-disk file: URI of the diff currently open in the active tab (resolving a staged diff's
// `git:` modified side back to the file path), or undefined when the active tab isn't a diff.
// True if the uri is a current change (staged, unstaged, or untracked) in its repo. Used to decide whether to
// badge a PLAIN-file editor tab: untracked/new files open as a plain file (git.openChange resolves to
// vscode.open, NOT vscode.diff, because an untracked file has no original side to diff against), so the badge
// must recognize them — but ONLY when they're an actual change, so it doesn't follow every random file you open.
const isChangeFileUri = (uri: vscode.Uri): boolean => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(uri) ?? git?.repositories?.[0];
        if (!repo) {
            return false;
        }
        const p = uri.path.toLowerCase();
        const inAny = (changes: any[]) => (changes ?? []).some((c: any) => c.uri.path.toLowerCase() === p);
        return inAny(repo.state.indexChanges) || inAny(repo.state.workingTreeChanges) || inAny(repo.state.untrackedChanges);
    } catch {
        return false; // git extension not ready / API shape changed — just don't badge
    }
};

// Resolves any diff-side / editor uri to the underlying on-disk file: uri. Handles git: uris (the real path
// is in the JSON query — staged/HEAD/index sides), plain file: uris, and any other scheme (fall back to the
// uri's own .path). Returns undefined only for a genuinely empty/absent side. This is the GENERAL resolver
// that lets the badge work for every change type without special-casing each git status.
const toFilePathUri = (uri: vscode.Uri | undefined): vscode.Uri | undefined => {
    if (!uri) {
        return undefined;
    }
    if (uri.scheme === "file") {
        return uri;
    }
    if (uri.scheme === "git") {
        try {
            const q = JSON.parse(uri.query); // git uri query carries {"path":"/abs/path","ref":...}
            if (q?.path) {
                return vscode.Uri.file(q.path);
            }
        } catch {
            // malformed/empty query — fall through to the uri's own path
        }
    }
    return uri.path ? vscode.Uri.file(uri.path) : undefined;
};

const currentReviewFileUri = (): vscode.Uri | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
        // Resolve the file path from EITHER side of the diff. A DELETED file has no working (modified) side so
        // its path is on the original (HEAD) side; an ADDED file has no original; a MODIFIED file has both.
        // Trying modified-then-original covers modify / add / delete / rename / staged variants generally,
        // instead of special-casing each git status. (Bug: the badge didn't follow deleted files.)
        return toFilePathUri(input.modified) ?? toFilePathUri(input.original);
    }
    // A 3-way MERGE editor (git conflict). TabInputTextMerge exists at runtime but isn't in this project's
    // @types/vscode (1.83), so duck-type it by shape (base/input1/input2/result); `result` is the on-disk
    // file being merged. The TabInputTextDiff check above already ran, so this shape is unambiguously a merge.
    const mergeInput = input as any;
    if (mergeInput && mergeInput.result && mergeInput.input1 && mergeInput.input2) {
        return toFilePathUri(mergeInput.result);
    }
    // A single editor (not a diff) — git opens some changes this way via `vscode.open`:
    //   • untracked/new files  -> the plain file: uri (no original to diff against)
    //   • DELETED files        -> the HEAD content under a git: uri (no working file to diff against)
    // Resolve EITHER form to the on-disk path via toFilePathUri (which decodes a git: uri's path), and badge
    // it only when it's an actual change so the badge doesn't follow every ordinary file you open.
    // (THE deleted-file bug, confirmed in git's getResources: a deletion has modified===undefined and opens
    // as a git: single editor — the old file:-scheme-only check skipped it, so the badge never matched.)
    if (input instanceof vscode.TabInputText) {
        const resolved = toFilePathUri(input.uri);
        if (resolved && isChangeFileUri(resolved)) {
            return resolved;
        }
    }
    return undefined;
};

// Matches VS Code's compareFileNames (src/vs/base/common/comparers.ts): a numeric, case-insensitive
// collator, so the navigation order is IDENTICAL to what the Source Control view shows for file names.
// BUG FIX: the comparators below previously compared the final filename segment with a naive `a < b`,
// which diverges from VS Code for numbered files (e.g. item-2 vs item-10, v2 vs v10) and some
// punctuation. That made next-change navigation jump to a file that wasn't the visually-next row in the
// panel (only "sometimes" — exactly when the naive order disagreed with the collator order).
const fileNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compareFileNames = (a: string, b: string): number => {
    const result = fileNameCollator.compare(a, b);
    if (result === 0 && a !== b) {
        return a < b ? -1 : 1; // numeric collator treats "foo1"/"foo01" as equal — disambiguate for a stable order
    }
    return result;
};

const orderFilesForListView = (a: any, b: any) => {
    // Order files same way as VSCode does it
    // 1) split by folders and compare pairwise
    // 2) if none have more folders: compare lexiographically
    // 3) if both have more folders, but folder are differing: compare lexiographically
    // 4) if only one have any more folders: order that last
    // 5) if both have more folders, and folders are same: compare next folder and go to step 2

    const filenameA = a.path.toLowerCase().split("/");
    const filenameB = b.path.toLowerCase().split("/");

    for (let i = 0; i < Math.max(filenameA.length, filenameB.length); i++) {
        const partA = filenameA[i];
        const partB = filenameB[i];

        if (partA === partB) {
            continue;
        }

        // Both paths are at their FINAL segment -> compare file names with the numeric collator (matches
        // VS Code's comparePaths, which uses compareFileNames here). This is the fix for the wrong-jump bug.
        if (i === filenameA.length - 1 && i === filenameB.length - 1) {
            return compareFileNames(partA, partB);
        }

        // Both paths are still inside differing DIRECTORY segments -> VS Code compares these naively
        // (comparePathComponents), so a plain lexicographic compare is correct here.
        if (i < filenameA.length - 1 && i < filenameB.length - 1) {
            if (partA < partB) {
                return -1;
            }
            if (partB < partA) {
                return 1;
            }
            return 0;
        }

        if (i === filenameA.length - 1) {
            return -1;
        }

        if (i === filenameB.length - 1) {
            return 1;
        }
    }

    return 0;
};

const orderFilesForTreeView = (a: any, b: any) => {
    // Order files same way as VSCode does it
    // 1) split by folders and compare pairwise
    // 2) if none have more folders: compare lexiographically
    // 3) if both have more folders, but folder are differing: compare lexiographically
    // 4) if only one have any more folders: order that first
    // 5) if both have more folders, and folders are same: compare next folder and go to step 2

    const filenameA = a.path.toLowerCase().split("/");
    const filenameB = b.path.toLowerCase().split("/");

    for (let i = 0; i < Math.max(filenameA.length, filenameB.length); i++) {
        const partA = filenameA[i];
        const partB = filenameB[i];

        if (partA === partB) {
            continue;
        }

        // Both paths at their FINAL segment -> compare file names with the numeric collator (matches VS
        // Code's tree-view sort, which uses compareFileNames on the node name). Fixes the wrong-jump bug.
        if (i === filenameA.length - 1 && i === filenameB.length - 1) {
            return compareFileNames(partA, partB);
        }

        // Differing DIRECTORY segments -> naive lexicographic compare (matches VS Code).
        if (i < filenameA.length - 1 && i < filenameB.length - 1) {
            if (partA < partB) {
                return -1;
            }
            if (partB < partA) {
                return 1;
            }
            return 0;
        }

        if (i === filenameA.length - 1) {
            return 1;
        }

        if (i === filenameB.length - 1) {
            return -1;
        }
    }

    return 0;
};

// VS Code git API Status enum (extensions/git/src/api/git.d.ts). We only need the staged-side members to
// pick the correct diff sides for a staged entry (see openChangeEntry). Kept as a plain const map (the git
// API isn't typed in this project) so the values are documented at the call site instead of being magic
// numbers. A newly-staged file is INDEX_ADDED (no HEAD blob); a staged deletion is INDEX_DELETED (no index
// blob) — those two are exactly the cases that used to throw "editor could not be opened / file not found".
// Every state a file can be in (vscode.git Status enum, extensions/git/src/api/git.d.ts). Listed in full so
// each is accounted for. Index/working-tree states are navigated + diffed; merge-conflict states (12-18) are
// navigated too (opened via git.openChange, which brings up the conflict / 3-way merge editor); IGNORED is
// the only one we skip (it's not a change to review).
const GitStatus = {
    INDEX_MODIFIED: 0,   // staged edit
    INDEX_ADDED: 1,      // staged new file (no HEAD side)
    INDEX_DELETED: 2,    // staged deletion (no index side)
    INDEX_RENAMED: 3,    // staged rename (HEAD side is at the ORIGINAL path)
    INDEX_COPIED: 4,     // staged copy   (HEAD side is at the ORIGINAL path)
    MODIFIED: 5,         // unstaged edit
    DELETED: 6,          // unstaged deletion
    UNTRACKED: 7,        // brand-new file, not yet added
    IGNORED: 8,          // gitignored — skipped
    INTENT_TO_ADD: 9,    // `git add -N` — treated like a new file (no HEAD side)
    INTENT_TO_RENAME: 10,
    TYPE_CHANGED: 11,    // e.g. file <-> symlink
    ADDED_BY_US: 12,     // ── merge conflicts ──
    ADDED_BY_THEM: 13,
    DELETED_BY_US: 14,
    DELETED_BY_THEM: 15,
    BOTH_ADDED: 16,
    BOTH_DELETED: 17,
    BOTH_MODIFIED: 18,
} as const;

// One navigable entry in the changes list. `staged` distinguishes the index (Staged Changes) copy from
// the working-tree (Changes) copy of the same file. They are SEPARATE diffs, and a partially-staged file
// legitimately appears as BOTH — exactly like the Source Control view shows it.
// `status` is the raw git status (vscode.git Status enum value) of the underlying change. For an UNSTAGED
// entry it's undefined (git.openChange handles those). For a STAGED entry it tells openChangeEntry which
// sides of the HEAD↔index diff actually have content, so we don't hand vscode.diff a git: URI for a blob
// that doesn't exist (the "file not found" bug — staged-add has no HEAD side, staged-delete has no index side).
interface FileChange {
    uri: vscode.Uri;
    staged: boolean;
    status?: number;
    originalUri?: vscode.Uri; // staged RENAME/COPY: the HEAD-side blob lives at this old path, not `uri`
}

// Unstaged file uris for a repo = tracked working-tree changes PLUS untracked (new) files, deduped by path
// and sorted to match the Source Control "Changes" group (VS Code's default "mixed" mode shows untracked
// there). The git API keeps untracked files (Status.UNTRACKED = 7) in state.untrackedChanges; depending on
// the git.untrackedChanges setting they can also appear in workingTreeChanges — so we read BOTH and dedupe by
// path. IGNORED files (status 8) are dropped. git.openChange opens an untracked file as a diff against an
// empty original (same as clicking its row), so untracked files navigate like any other entry.
// BUG FIX: the old code filtered untracked out everywhere (status !== 7), so a brand-new file was never
// navigated to or advanced to by stage-and-next — it "wasn't even considered". New files are first-class now.
const getUnstagedUris = (repo: any, isTreeView: boolean): vscode.Uri[] => {
    const working: any[] = repo.state.workingTreeChanges ?? [];
    const untracked: any[] = repo.state.untrackedChanges ?? [];
    const byPath = new Map<string, vscode.Uri>();
    for (const change of [...working, ...untracked]) {
        if (change.status === 8) {
            continue; // skip IGNORED files (Status.IGNORED) — they're not real changes to review
        }
        byPath.set(change.uri.path.toLowerCase(), change.uri); // dedupe: a file can appear in both groups
    }
    return [...byPath.values()].sort(isTreeView ? orderFilesForTreeView : orderFilesForListView);
};

const getFileChanges = async (): Promise<FileChange[]> => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const workspaceUri = vscode.workspace.workspaceFolders?.map((ws) => ws.uri)[0];
    // Prefer the repo that owns the file CURRENTLY BEING REVIEWED (tab-derived, focus-independent) so a
    // multi-root workspace navigates within the right repo — falling through from a file in repo B used to
    // build repo A's list, miss the file (findCurrentIndex -1) and silently stop (Codex review, v1.2.1).
    // Fall back to the first workspace folder's repo / first known repo, as before.
    const reviewUri = currentReviewFileUri();
    const activeRepo =
        (reviewUri && git.getRepository(reviewUri)) || git.getRepository(workspaceUri?.path) || git.repositories[0];
    const isTreeView = vscode.workspace.getConfiguration("better-git-vscode").get("treeView");

    // Keep the git status alongside the uri for staged entries: openChangeEntry needs it to choose which
    // diff sides exist (a newly-staged INDEX_ADDED file has no HEAD blob; a staged INDEX_DELETED file has no
    // index blob). We sort on the URI just like before, but carry {uri,status} through the sort so the
    // status isn't lost. (Sorting plain uris and re-deriving status later would be fragile across dup paths.)
    const indexChanges: FileChange[] = activeRepo.state.indexChanges
        .filter((file: any) => file.status !== 7)
        .map((file: any) => ({ uri: file.uri as vscode.Uri, status: file.status as number, originalUri: file.originalUri as vscode.Uri | undefined }))
        .sort((a: any, b: any) => (isTreeView ? orderFilesForTreeView : orderFilesForListView)(a.uri, b.uri))
        .map((entry: any) => ({ uri: entry.uri, staged: true, status: entry.status, originalUri: entry.originalUri }));

    // Unstaged group = tracked working-tree changes PLUS untracked (new) files (see getUnstagedUris), tagged
    // unstaged. Untracked files used to be filtered out here, so they were skipped by navigation entirely.
    const workingTreeChanges: FileChange[] = getUnstagedUris(activeRepo, !!isTreeView).map((uri) => ({ uri, staged: false }));

    // Merge-conflict files (state.mergeChanges) — "both modified", "added by us/them", etc. VS Code lists
    // these in a "Merge Changes" group ABOVE staged/unstaged. Included so conflicts are navigable too; they're
    // opened via git.openChange (the staged:false path), which brings up the conflict / 3-way merge editor.
    // Empty array when there's no merge in progress, so this is a no-op in the normal case.
    const mergeChanges: FileChange[] = (activeRepo.state.mergeChanges ?? [])
        .map((file: any) => file.uri as vscode.Uri)
        .sort(isTreeView ? orderFilesForTreeView : orderFilesForListView)
        .map((uri: vscode.Uri) => ({ uri, staged: false }));

    // BUG FIX: a file that is partially staged (or staged and then edited again) appears in BOTH
    // indexChanges and workingTreeChanges with the SAME on-disk path — so it shows twice here, just as it
    // does in the Source Control view (once under Staged Changes, once under Changes). The previous code
    // matched the current position by PATH ONLY, which always resolved to the FIRST (staged) copy, while
    // VSCode's git.openChange always opens the WORKING-TREE diff for such a file (getSCMResource prefers
    // the working tree group). That mismatch made next-change navigation jump to the wrong file or loop.
    // The fix is NOT to de-duplicate (that reorders the list vs what the user sees); instead we TAG each
    // entry with its side here, then disambiguate by {path, staged} in findCurrentIndex and open the
    // matching side in openChangeEntry. Order mirrors the SCM view exactly: Staged group, then Changes
    // group. Repro before fix: stage file A, edit A again, then from a staged file above A press the
    // next-change shortcut past A's last diff — it jumped to A's unstaged copy instead of advancing.
    return [...mergeChanges, ...indexChanges, ...workingTreeChanges];
};

// Describes which diff is currently focused: the file path, and whether it is the staged (index) side.
// `staged` is null when we can't tell (a plain file editor, or a non-textual file), in which case callers
// fall back to a path-only match (legacy behavior).
interface ActiveChange {
    path: string;
    staged: boolean | null;
}

const getActiveChange = async (): Promise<ActiveChange | null> => {
    // Prefer the active tab's diff input: it exposes the modified (right) side regardless of which pane
    // has keyboard focus. VSCode's git extension builds the modified side as a `git`-scheme uri for the
    // index/staged diff and the plain `file` uri for the working-tree diff (see getRightResource in
    // vscode/extensions/git/src/repository.ts), so the scheme tells us the side unambiguously.
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
        return { path: input.modified.path, staged: input.modified.scheme === "git" };
    }
    // 3-way merge editor (conflict). Duck-typed (TabInputTextMerge isn't in @types/vscode 1.83); `result` is
    // the working-tree file. Treat as the unstaged side for matching.
    const mergeInput = input as any;
    if (mergeInput && mergeInput.result && mergeInput.input1 && mergeInput.input2) {
        return { path: mergeInput.result.path as string, staged: false };
    }

    // PLAIN single-editor tab (v1.2.1 fix): resolve the path from the TAB itself, focus-independently.
    // Two change kinds open as plain tabs: untracked new files (file: uri) and DELETED files (their HEAD
    // content under a git: uri — toFilePathUri decodes the real path from the git: query). The old code
    // fell straight through to getActiveFilePath(), which reads vscode.window.activeTextEditor — the
    // FOCUSED editor, which can be a stale different-file editor when focus is in the SCM panel. That stale
    // path then missed in findCurrentIndex (-1 -> bail), making next-change a hard silent no-op on deleted
    // files. Tab-first resolution fixes it; side stays null (a plain tab doesn't tell staged vs unstaged).
    if (input instanceof vscode.TabInputText) {
        const resolved = toFilePathUri(input.uri);
        if (resolved) {
            return { path: resolved.path, staged: null };
        }
    }

    // Fallback for non-textual files (images etc.): path only, side unknown.
    const path = await getActiveFilePath();
    return path ? { path, staged: null } : null;
};

// Index of the active change within the list. Matches by normalized path AND staged side when the side is
// known, so the staged and unstaged copies of a partially-staged file are told apart (the core bug fix).
const findCurrentIndex = (fileChanges: FileChange[], active: ActiveChange): number => {
    const normalized = active.path.slice(1).replace(/\\/g, "/").toLowerCase();
    const pathMatches = (entry: FileChange) => entry.uri.path.toLowerCase().endsWith(normalized);

    if (active.staged !== null) {
        const exact = fileChanges.findIndex((entry) => entry.staged === active.staged && pathMatches(entry));
        if (exact !== -1) {
            return exact;
        }
    }

    const firstPath = fileChanges.findIndex(pathMatches);
    if (firstPath === -1) {
        return -1; // active file isn't a known change at all
    }

    // AMBIGUITY GUARD (fixes an intermittent "previous jumps to the last change" bug): when the side is
    // UNKNOWN (the active tab wasn't a readable diff so getActiveChange fell back to staged=null) AND the
    // file appears in BOTH the staged and unstaged groups (a dual-state file), a path-only match would just
    // guess the first (staged) copy. Returning that uncertain index let the new looping fling navigation to
    // the wrong end of the list. Return -1 instead so callers bail and do nothing; the next press (once the
    // diff tab is readable and the side is known) navigates correctly.
    if (active.staged === null && fileChanges.filter(pathMatches).length > 1) {
        return -1;
    }
    return firstPath;
};

// Replicates vscode/extensions/git/src/uri.ts toGitUri: a `git`-scheme uri whose JSON query carries the
// real fs path + a git ref. Needed to open the STAGED (index) diff of a file directly, because
// git.openChange(fileUri) resolves a plain file uri to the WORKING-TREE resource whenever one exists
// (getSCMResource prefers workingTreeGroup) — so it can't reach the staged side of a partially-staged file.
const toGitUri = (uri: vscode.Uri, ref: string): vscode.Uri => {
    return uri.with({ scheme: "git", path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });
};

// The git "empty tree" object id — `git show <empty-tree>:<path>` resolves to an empty buffer instead of
// erroring, which is exactly how VS Code's git: content provider serves a "this side has no content" placeholder
// (its readFile special-cases `ref === getEmptyTree()` -> 0 bytes). We use it as the empty side when opening
// the staged diff of a newly-ADDED file (no HEAD blob) or a staged-DELETED file (no index blob), so vscode.diff
// gets a resolvable URI on both sides and doesn't throw "file not found".
// 4b825dc...4904 is the canonical SHA-1 empty-tree id; b2d... is the SHA-256 equivalent for sha256-object repos.
// We pick by inspecting an existing ref's length isn't reliable here, so we try to ask git via the extension's
// repository object first, and fall back to the SHA-1 constant (the overwhelmingly common case).
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
const getEmptyTreeRef = async (uri: vscode.Uri): Promise<string | undefined> => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(uri) ?? git?.repositories?.[0];
        // The git extension API doesn't surface getEmptyTree(), but we can detect the object format from the
        // repo's commit hashes when available; default to SHA-1 (covers virtually all real-world repos).
        const head: string | undefined = repo?.state?.HEAD?.commit;
        if (head && head.length === 64) {
            return EMPTY_TREE_SHA256; // sha256 repo
        }
        return EMPTY_TREE_SHA1;
    } catch {
        return EMPTY_TREE_SHA1; // git extension not ready / API shape changed — SHA-1 empty tree is the safe default
    }
};

// Opens the diff for a single list entry on the correct (staged vs unstaged) side.
const openChangeEntry = async (entry: FileChange): Promise<void> => {
    if (!entry.staged) {
        // Working-tree (unstaged) diff — git.openChange opens this side correctly, including untracked/new
        // files (it shows them as a plain editor, the same as clicking the row). Defensive fallback: if a
        // view genuinely can't be produced, open the file itself so the command never no-ops.
        try {
            await vscode.commands.executeCommand("git.openChange", entry.uri);
        } catch {
            await vscode.window.showTextDocument(entry.uri, { preview: true });
        }
        // SILENT-NO-OP GUARD (Codex review, v1.2.1): with git.untrackedChanges="separate", untracked files
        // live in the separate untracked group and git.openChange(uri) resolves nothing for them — and it
        // does NOT throw, so the catch above never fires and navigation would just... stay put. Verify the
        // active tab actually shows the requested file now; if not, open it directly. (uriFilePathOfTab
        // logic: reuse currentReviewFileUri-style tab reading via activeTab input.)
        const shownInput: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        const shownUri =
            shownInput instanceof vscode.TabInputTextDiff
                ? toFilePathUri(shownInput.modified) ?? toFilePathUri(shownInput.original)
                : shownInput instanceof vscode.TabInputText
                    ? toFilePathUri(shownInput.uri)
                    : undefined;
        if (!shownUri || shownUri.path.toLowerCase() !== entry.uri.path.toLowerCase()) {
            try {
                await vscode.window.showTextDocument(entry.uri, { preview: true });
            } catch {
                // file unreadable (e.g. binary/permission edge) — nothing more we can do, but we tried both paths
            }
        }
        return;
    }
    // OPT-IN WORKAROUND (better-git-vscode.revealStagedInSourceControl): highlight the staged file in the
    // Source Control view. VS Code's built-in `scm.autoReveal` can't do this for staged files because the
    // staged diff opens with a `git:` uri and autoReveal only matches sidebar rows by their `file:` path
    // (there is NO extension API to select an SCM row directly). Trick: briefly make the plain file the
    // active editor — autoReveal then finds it (a staged-only file's file: uri lives only in the index
    // group) and selects/reveals its row — then we open the staged diff over it. autoReveal never CLEARS a
    // selection on a no-match, so the staged row stays highlighted while the diff is shown. Caveats, which
    // is why this is off by default: a brief flash of the file before the diff, and for a partially-staged
    // (dual-state) file autoReveal picks the working-tree row instead (it scans groups back-to-front).
    const revealStaged = vscode.workspace.getConfiguration("better-git-vscode").get("revealStagedInSourceControl");
    if (revealStaged) {
        try {
            await vscode.window.showTextDocument(entry.uri, { preview: true }); // fires autoReveal -> selects the staged row
        } catch {
            // File can't be opened (e.g. a staged deletion) — skip the reveal, still show the diff below.
        }
    }

    // Staged (index) diff: open HEAD-vs-index explicitly so it works even for a partially-staged file
    // (where git.openChange would otherwise show the working-tree diff). preview:true mirrors single-click
    // SCM behavior so the existing preview-tab handling keeps working. The git-scheme modified side also
    // makes getActiveChange detect this as staged, so subsequent next/previous navigation stays anchored to
    // the correct list entry.
    //
    // BUG FIX ("The editor could not be opened because the file was not found" on staged files):
    // The git: scheme content provider serves a side by running `git show <ref>:<path>` (verified in VS
    // Code's GitFileSystemProvider.readFile -> Repository.buffer). If the requested ref has no blob for that
    // path, git errors and the provider throws FileSystemError.FileNotFound — which surfaces as that exact
    // editor error. The old code ALWAYS built left=toGitUri(HEAD) + right=toGitUri("") regardless of git
    // status, so the two staged statuses where one side legitimately has NO blob blew up:
    //   • INDEX_ADDED  (a brand-new file you just `git add`-ed): no HEAD blob -> `git show HEAD:path` fails.
    //   • INDEX_DELETED (a tracked file you staged for deletion):  no index blob -> `git show :path` fails.
    // VS Code itself never hits this: its getLeftResource has NO case for INDEX_ADDED (returns {} -> empty
    // left), and INDEX_DELETED opens with an empty right. We mirror that here by status:
    //   • INDEX_ADDED   -> left = empty-tree git: uri (provider returns 0 bytes), right = index  => shown as fully added.
    //   • INDEX_DELETED -> left = HEAD,                                            right = empty-tree    => shown as fully removed.
    //   • everything else (INDEX_MODIFIED / RENAMED / COPIED / unknown) -> HEAD ↔ index, as before.
    // The empty-tree object id is the one ref the content provider maps to an empty buffer instead of
    // throwing (see readFile's `if (r === await getEmptyTree()) return new Uint8Array(0)`), so it's the
    // correct, guaranteed-resolvable "this side has no content" placeholder — not a made-up ref.
    const emptyTreeRef = await getEmptyTreeRef(entry.uri);
    let left: vscode.Uri;
    let right: vscode.Uri;
    if (entry.status === GitStatus.INDEX_ADDED || entry.status === GitStatus.INTENT_TO_ADD) {
        // Newly-staged / intent-to-add file: nothing at HEAD. Use the empty tree as the (empty) original side.
        left = emptyTreeRef ? toGitUri(entry.uri, emptyTreeRef) : toGitUri(entry.uri, "HEAD");
        right = toGitUri(entry.uri, ""); // "" ref => the index/staged content (git show :path)
    } else if (entry.status === GitStatus.INDEX_DELETED) {
        // Staged deletion: nothing in the index. Diff HEAD content against the empty tree (fully removed).
        left = toGitUri(entry.uri, "HEAD");
        right = emptyTreeRef ? toGitUri(entry.uri, emptyTreeRef) : toGitUri(entry.uri, "");
    } else {
        // INDEX_MODIFIED / INDEX_RENAMED / INDEX_COPIED / TYPE_CHANGED (and any unknown staged status): both
        // sides exist. CRITICAL for RENAME/COPY (the "R doesn't work" bug): the HEAD blob lives at the
        // ORIGINAL path, NOT entry.uri (the new path) — so `git show HEAD:<newpath>` errors with "file not
        // found" and the diff never opens. entry.originalUri is the old path (and equals uri for non-renames),
        // so it's the correct HEAD side for every case.
        left = toGitUri(entry.originalUri ?? entry.uri, "HEAD");
        right = toGitUri(entry.uri, ""); // index content at the (new) path
    }
    const title = `${entry.uri.path.split("/").pop()} (Index)`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
};

const openFirstFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("better-git-vscode").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    if (fileChanges.length === 0) {
        return;
    }

    await openChangeEntry(fileChanges[0]);
};

const openLastFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("better-git-vscode").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    if (fileChanges.length === 0) {
        return;
    }

    await openChangeEntry(fileChanges[fileChanges.length - 1]);
};

const openNextFile = async () => {
    const fileChanges = await getFileChanges();

    const active = await getActiveChange();
    if (!active) {
        return;
    }

    if (fileChanges.length === 0) {
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        // Couldn't reliably locate the active file (e.g. its diff side wasn't readable for a dual-state
        // file). Bail rather than guess — guessing turned into a jump to the wrong file. A re-press works.
        return;
    }

    // LOOP: wrap to the first file when at the end (one press loops back to the start), instead of closing
    // the editor. At the last index, (len-1 + 1) % len = 0 -> first file.
    const nextIndex = (currentIndex + 1) % fileChanges.length;

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[nextIndex]);
};

const openPreviousFile = async () => {
    const fileChanges = await getFileChanges();
    const active = await getActiveChange();
    if (!active) {
        return;
    }

    if (fileChanges.length === 0) {
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        // BUG FIX (intermittent "previous jumps to the last staged change"): the old code did
        // `currentIndex <= 0 ? last : currentIndex - 1`, which treated "not found" (-1) the SAME as "at the
        // first file" (0) and wrapped to the LAST file. When the diff side wasn't readable for a dual-state
        // file, findCurrentIndex returned -1 and "previous" lurched to the last change. Now we bail on -1;
        // the next press (once the diff tab is readable) navigates correctly. Genuine index 0 still loops.
        return;
    }

    // LOOP: wrap to the last file only when genuinely at the first file (index 0).
    const prevIndex = currentIndex === 0 ? fileChanges.length - 1 : currentIndex - 1;

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[prevIndex]);
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
};

// NEW-FILE detection (Ethan 2026-07-03, HARDENED in v1.2.1): a file is "fully added" when its entire
// content is one big new-diff — i.e. its git status is a whole-new-file state with NO original content:
// untracked (Status.UNTRACKED), staged-new (INDEX_ADDED), or intent-to-add (INTENT_TO_ADD).
//
// v1.2.1 ROOT-CAUSE FIXES baked in here (the v1.2.0 version of this check caused the "next-change stopped
// advancing / 5-line jump fired on modified files" regression):
//   • DUAL-STATE GUARD: a file staged as new (INDEX_ADDED) and then edited again is ALSO a working-tree
//     MODIFIED change — its working-tree diff has real hunks, so it must use normal hunk navigation. The
//     old check returned true purely because an INDEX_ADDED entry existed, hijacking hunk nav into 5-line
//     crawling. Now ANY non-new working-tree status (MODIFIED / DELETED / renamed / type-changed / conflict)
//     vetoes new-file mode outright.
//   • NO REPO GUESSING: the old `getRepository(uri) ?? repositories[0]` fell back to the FIRST repo when the
//     lookup missed, so a multi-repo workspace could consult the wrong repo's change lists. Now: no owning
//     repo (or git API not ready) -> false -> normal navigation. Never a silent no-op.
//   • file:-scheme only: a DELETED file's "editor" is HEAD content under a git: uri — resolving it to the
//     on-disk path and then status-matching could never be a whole-new-file state, but we guard the scheme
//     explicitly anyway so deleted/virtual views can't even reach the status lookup.
const isFullyAddedFile = (uri: vscode.Uri | undefined): boolean => {
    const fileUri = toFilePathUri(uri);
    if (!fileUri || fileUri.scheme !== "file") {
        return false;
    }
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        // Only trust the repo that actually CONTAINS this file — see NO REPO GUESSING note above.
        const repo = git?.getRepository(fileUri);
        if (!repo) {
            return false;
        }
        const p = fileUri.path.toLowerCase();
        const find = (changes: any[]) => (changes ?? []).find((c: any) => c.uri.path.toLowerCase() === p);
        // Working-tree entry first, because it can VETO. With the default git.untrackedChanges="mixed",
        // untracked files land here with status UNTRACKED; `git add -N` files land here as INTENT_TO_ADD.
        const wt = find(repo.state.workingTreeChanges);
        const wtIsNew = wt && (wt.status === GitStatus.UNTRACKED || wt.status === GitStatus.INTENT_TO_ADD);
        if (wt && !wtIsNew) {
            // Tracked working-tree change (MODIFIED / DELETED / INTENT_TO_RENAME / TYPE_CHANGED / ...):
            // there IS original content to diff against -> normal hunk navigation. This is the dual-state
            // guard: it fires even if the file is simultaneously INDEX_ADDED in the index.
            return false;
        }
        if (wtIsNew) {
            return true;
        }
        // git.untrackedChanges="separate" keeps untracked files in their own list — everything in it is
        // by definition a whole-new file.
        if (find(repo.state.untrackedChanges)) {
            return true;
        }
        // Staged brand-new file with NO working-tree entry at all (clean since staging): the index entry
        // must be a whole-new-file status. INDEX_DELETED / INDEX_RENAMED / INDEX_MODIFIED etc. all fail
        // this check — renames are git's classic "delete+add" trap and must navigate normally.
        const idx = find(repo.state.indexChanges);
        return !!idx && (idx.status === GitStatus.INDEX_ADDED || idx.status === GitStatus.INTENT_TO_ADD);
    } catch {
        return false; // git API not ready / shape changed — fall back to normal change navigation
    }
};

// Resolves the TextEditor OBJECT that is actually rendering the active TAB's document (for a side-by-side
// diff: its MODIFIED/right side; for a plain tab: that document's editor). This is NOT the same thing as
// vscode.window.activeTextEditor — that is the *focused* editor (or the most recently focused one), and in
// Ethan's review flow keyboard focus frequently sits in the Source Control panel: SCM single-clicks open
// files with preserveFocus:true, so activeTextEditor can keep pointing at a completely DIFFERENT file.
// THE v1.2.0 BUG: goToNextDiff decided "new file? -> step" from the active tab but then stepped
// vscode.window.activeTextEditor — when the two disagreed, the cursor moved invisibly in a stale/hidden
// editor (perceived hard no-op, "not going to next change") or 5-line-stepped a MODIFIED file's editor.
// Navigation must decide AND act on the same tab-derived editor; this helper is that single source of truth.
const visibleEditorForActiveTab = (): vscode.TextEditor | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    let target: vscode.Uri | undefined;
    if (input instanceof vscode.TabInputTextDiff) {
        target = input.modified; // change-navigation moves the cursor on the right/modified side
    } else if (input instanceof vscode.TabInputText) {
        target = input.uri;
    }
    if (!target) {
        return undefined; // webview / binary / merge tab — no plain text editor to resolve
    }
    const key = target.toString();
    // uri.toString() compares scheme + path + query, so the two git:-scheme sides of a staged diff (same
    // path, different ref in the query) cannot be confused with each other or with the on-disk file.
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
};

// THE STRUCTURAL GATE for new-file scroll mode (v1.2.1). Returns the editor to 5-line-step through, or
// undefined meaning "use normal navigation". ALL FOUR conditions must hold:
//   (a) the active tab is a PLAIN single editor (TabInputText) — NOT a side-by-side diff. A diff tab means
//       an original side exists, so hunk navigation applies. This alone makes it structurally IMPOSSIBLE
//       for a MODIFIED file (which always opens as a diff) to get the 5-line step — the exact v1.2.0
//       regression Ethan reproduced. Trade-off accepted: a staged-new file opened as its empty-original
//       DIFF now falls through to normal nav (advances to the next file) instead of stepping; opening the
//       plain file still steps. Never compromise modified-file navigation for that case.
//   (b) the tab shows the ON-DISK file (file: scheme). A DELETED file also opens as a plain editor, but of
//       the HEAD blob under a git: uri — its content is REMOVED, not added, so it must never scroll-step.
//   (c) git confirms the whole file is genuinely new (isFullyAddedFile above, with its dual-state guard).
//   (d) a visible TextEditor for that exact document exists — we only ever step the editor the user is
//       LOOKING at. No match (races, weird layouts) -> undefined -> normal navigation, never a silent no-op.
const newFileScrollEditor = (): vscode.TextEditor | undefined => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!(tab?.input instanceof vscode.TabInputText)) {
        return undefined; // (a) not a plain single-editor tab
    }
    const uri = tab.input.uri;
    if (uri.scheme !== "file") {
        return undefined; // (b) deleted-file / virtual-document guard
    }
    if (!isFullyAddedFile(uri)) {
        return undefined; // (c) not a genuinely brand-new file
    }
    const key = uri.toString();
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key); // (d)
};

// Shared step logic for new-file scroll mode: move the cursor `direction` by newFileNavLineJump lines within
// a fully-added file so you can page through it. Returns true if it stepped (caller stops), or false if the
// cursor is already at the edge (caller falls through to the next/previous FILE — matching the normal
// end-of-changes behaviour so the review flow keeps going).
// v1.2.1: async + focuses the editor being stepped. An UNFOCUSED editor renders no caret, so when focus sat
// in the SCM panel the old steps were invisible (part of the perceived "nothing happens"). We also reveal
// InCenter (not InCenterIfOutsideViewport) so every press produces visible scroll feedback once the file is
// taller than the viewport.
const stepThroughNewFile = async (editor: vscode.TextEditor, direction: "down" | "up"): Promise<boolean> => {
    const configured = vscode.workspace.getConfiguration("better-git-vscode").get<number>("newFileNavLineJump", 5);
    // Guard bad user values: 0 / negative / NaN would "step" in place forever — a permanent no-op. Floor
    // fractional values; anything non-usable falls back to the default 5.
    const step = Number.isFinite(configured) && (configured as number) >= 1 ? Math.floor(configured as number) : 5;
    const cur = editor.selection.active.line;
    const last = Math.max(0, editor.document.lineCount - 1);
    const atEdge = direction === "down" ? cur >= last : cur <= 0;
    if (atEdge) {
        return false;
    }
    const target = direction === "down" ? Math.min(cur + step, last) : Math.max(cur - step, 0);
    // Focus the editor we're about to step (safe here: the gate guarantees a plain file: document, never a
    // diff side or virtual doc). showTextDocument on an already-visible document re-uses its tab/column.
    // If focusing fails for any reason, still step the unfocused editor — movement over silence.
    let stepEditor = editor;
    try {
        stepEditor = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    } catch {
        // keep the unfocused editor — the selection/reveal below still applies
    }
    const pos = new vscode.Position(target, 0);
    stepEditor.selection = new vscode.Selection(pos, pos);
    stepEditor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenter);
    return true;
};

const goToNextDiff = async () => {
    var activeEditor = vscode.window.activeTextEditor;
    const currentFilename = await getActiveFilePath();
    if (!activeEditor && !currentFilename) {
        await openFirstFile();
        return;
    }

    // NEW-FILE SCROLL MODE: for a brand-new file shown as a PLAIN editor (whole file is one new-diff with
    // no original side), step DOWN newFileNavLineJump lines to page through it; at the bottom fall through
    // to the next changed file. newFileScrollEditor() is the strict v1.2.1 gate — it both DECIDES (plain
    // tab + file: scheme + genuinely-new git status) and RESOLVES the editor to act on (the tab's own
    // visible editor, never a possibly-stale vscode.window.activeTextEditor). The v1.2.0 code split those
    // two concerns across different editors, which is what made modified files 5-line-step and new files
    // silently no-op — see the comments on isFullyAddedFile / newFileScrollEditor for the full post-mortem.
    const newFileEditor = newFileScrollEditor();
    if (newFileEditor) {
        if (await stepThroughNewFile(newFileEditor, "down")) {
            return;
        }
        await openNextFile();
        return;
    }

    // Hunk navigation. Read the cursor from the TAB's own editor (falling back to the focused editor) so
    // the moved/didn't-move detection below works even when keyboard focus is in the SCM panel —
    // activeTextEditor alone could be a stale different-file editor there, which made the before/after
    // compare meaningless (always "didn't move" -> premature file jumps, or missed jumps).
    const navEditor = visibleEditorForActiveTab() ?? activeEditor;
    const lineBefore = navEditor?.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");
    const lineAfter = navEditor?.selection.active.line; // TextEditor.selection is live — same object, post-command state

    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter > lineBefore)) {
        // We've run out of changes in the current file. Jump straight to the next changed file —
        // NO confirmation prompt, ever. The whole point of this tool is keyboard-fast review; a
        // "Jump to next file: ...?" modal would defeat that. (The old promptBeforeNextFile setting +
        // its modal confirmation path were removed entirely — see CHANGELOG v1.0.2.)
        await openNextFile();
        return;
    }
};

const goToPreviousDiff = async () => {
    var activeEditor = vscode.window.activeTextEditor;
    const currentFilename = await getActiveFilePath();
    if (!activeEditor && !currentFilename) {
        await openLastFile();
        return;
    }

    // NEW-FILE SCROLL MODE (mirror of goToNextDiff — same strict v1.2.1 gate, see comments there): step UP
    // newFileNavLineJump lines through a brand-new plain-editor file; at the top, fall through to the
    // previous changed file.
    const newFileEditor = newFileScrollEditor();
    if (newFileEditor) {
        if (await stepThroughNewFile(newFileEditor, "up")) {
            return;
        }
        await openPreviousFile();
        return;
    }

    // Hunk navigation — tab-derived editor for the before/after compare, same rationale as goToNextDiff.
    const navEditor = visibleEditorForActiveTab() ?? activeEditor;
    const lineBefore = navEditor?.selection.active.line;
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    const lineAfter = navEditor?.selection.active.line; // live selection — post-command state

    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter < lineBefore)) {
        // Out of changes in the current file -> jump straight to the previous changed file, NO prompt.
        // Same rationale as goToNextDiff: the confirmation modal was removed entirely (see CHANGELOG v1.0.2).
        await openPreviousFile();
    }
};

const goToFirstOrNextFile = async () => {
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        await openFirstFile();
        return;
    }

    await openNextFile();
};

const goToLastOrPreviousFile = async () => {
    const currentFilename = await getActiveFilePath();
    if (!currentFilename) {
        await openLastFile();
        return;
    }

    await openPreviousFile();
};

// FEATURE (stage-and-next-changed-file — shift+alt+. QWERTY / shift+alt+v Dvorak): stage the whole current file, then jump straight to the next UNSTAGED file so
// you can review-and-stage without reaching for the mouse to click the + each time.
// Stages the current file and stays put (no navigation) — backs the editor-title "Stage current file" button.
// Reuses getActiveFileUri (tab-aware, so it works from a diff or a plain editor) and isChangeFileUri as the
// safety guard, so it only ever runs `git add` on an actual change — never on a clean/unrelated file.
const stageCurrentFile = async () => {
    const currentUri = await getActiveFileUri();
    if (!currentUri || !isChangeFileUri(currentUri)) {
        return; // no active file, or it's not a change -> nothing to stage
    }
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);
    const activeRepo = git.getRepository(currentUri) || git.repositories[0];
    if (activeRepo) {
        // Route through the single stage chokepoint: stages (same as clicking the + in Source Control) AND
        // records it in the last-staged status bar. No advance here — this command stays on the file.
        await stageThroughExtension(activeRepo, currentUri);
    }
};

// Stages the current file, then opens the adjacent unstaged file in `direction`. Shared by both
// stage-and-advance commands: "next" advances down the list (top-to-bottom review, shift + next), "previous"
// moves up (bottom-to-top review, shift + previous). Only the landing-target differs; everything else (the
// staged-side no-op, the safety guard, the untracked-aware list, the editor handling) is identical.
const stageCurrentFileAndAdvance = async (direction: "next" | "previous") => {
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!.exports;
    const git = gitExtension.getAPI(1);

    const currentUri = await getActiveFileUri();
    if (!currentUri) {
        return;
    }

    // If the active diff is the STAGED side of a file, there's nothing to stage — do nothing (don't jump
    // to an unstaged file). This command is for working through UNSTAGED files; on a staged file it no-ops.
    const activeSide = await getActiveChange();
    if (activeSide?.staged === true) {
        return;
    }

    // Resolve the repository from the CURRENT file (not just the first workspace folder) so a multi-root
    // workspace stages against the right repo and computes the next file from the right state.
    const activeRepo = git.getRepository(currentUri) || git.repositories[0];
    if (!activeRepo) {
        return;
    }

    const currentNormalized = currentUri.path.slice(1).replace(/\\/g, "/").toLowerCase();
    const pathMatches = (uri: vscode.Uri) => uri.path.toLowerCase().endsWith(currentNormalized);

    // SAFETY GUARD: only act if the active file is actually a change (staged, unstaged, or untracked).
    // Without this, an accidental stage-and-advance shortcut while editing a clean/unrelated file would run
    // git add as a no-op and then close that editor — a nasty surprise. Untracked is included so staging a brand-new
    // file still works; navigation below stays within tracked unstaged files (see note).
    const untrackedChanges = activeRepo.state.untrackedChanges ?? [];
    const isChangedFile =
        activeRepo.state.indexChanges.some((file: any) => pathMatches(file.uri)) ||
        activeRepo.state.workingTreeChanges.some((file: any) => pathMatches(file.uri)) ||
        untrackedChanges.some((file: any) => pathMatches(file.uri));
    if (!isChangedFile) {
        return;
    }

    // Work out the next unstaged file BEFORE staging. activeRepo.state updates asynchronously after a
    // stage, so reading the list afterwards would see a stale snapshot (current file still present) or
    // shifted indices. Capturing the target up-front makes where-we-land deterministic. The unstaged list
    // now INCLUDES untracked/new files (see getUnstagedUris) so stage-and-advance lands on a brand-new file
    // too — git.openChange opens them as a diff vs an empty original, so they're navigable like any other.
    const isTreeView = vscode.workspace.getConfiguration("better-git-vscode").get("treeView");
    const workingTreeChanges = getUnstagedUris(activeRepo, !!isTreeView);

    const currentIndex = workingTreeChanges.findIndex(pathMatches);
    // Where to land after staging, by direction:
    //   "next"     -> the file AFTER the current one (top-to-bottom review); if it was the LAST, fall back to
    //                 the PREVIOUS one so we don't strand you. Not in the list -> the FIRST unstaged file.
    //   "previous" -> the file BEFORE the current one (bottom-to-top review); if it was the FIRST, fall back
    //                 to the NEXT one. Not in the list -> the LAST unstaged file.
    // The ?? handles the boundary; for the only-file case the fallback index is out of range and returns
    // undefined (-> close the editor below, nothing left to review).
    let targetUnstagedFile: vscode.Uri | undefined;
    if (currentIndex === -1) {
        targetUnstagedFile = direction === "next" ? workingTreeChanges[0] : workingTreeChanges[workingTreeChanges.length - 1];
    } else if (direction === "next") {
        targetUnstagedFile = workingTreeChanges[currentIndex + 1] ?? workingTreeChanges[currentIndex - 1];
    } else {
        targetUnstagedFile = workingTreeChanges[currentIndex - 1] ?? workingTreeChanges[currentIndex + 1];
    }

    // Stage the whole current file — equivalent to clicking the + next to it in the Source Control view.
    // CRITICAL ORDERING: we stage (and record last-staged) via the chokepoint HERE, BEFORE advancing the
    // active editor below. We must capture the STAGED file's identity (currentUri, resolved at the top of
    // this function) now — the advance switches the editor to the NEXT file, so reading the active file
    // afterwards would record the wrong file. stageThroughExtension only updates the status bar if add()
    // succeeds, so a no-op/failed stage won't show a file in the bar.
    await stageThroughExtension(activeRepo, currentUri);

    if (!targetUnstagedFile) {
        // Current was the ONLY unstaged file (no next and no previous) — nothing left to review, so close.
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
    }

    // Mirror openNextFile's editor handling: replace a pinned (non-preview) editor, keep a preview tab.
    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await vscode.commands.executeCommand("git.openChange", targetUnstagedFile);
};

const getActiveFilePath = async (): Promise<string> => {
    var activeEditor = vscode.window.activeTextEditor;
    const currentFilename = activeEditor?.document.uri.path;
    if (currentFilename) {
        return currentFilename;
    }

    // Since there is no API to get details of non-textual files, the following workaround is performed:
    // 1. Saving the original clipboard data to a local variable.
    const originalClipboardData = await vscode.env.clipboard.readText();

    // 2. Populating the clipboard with an empty string
    await vscode.env.clipboard.writeText("");

    // 3. Calling the copyPathOfActiveFile that populates the clipboard with the source path of the active file.
    // If there is no active file - the clipboard will not be populated and it will stay with the empty string.
    await vscode.commands.executeCommand("workbench.action.files.copyPathOfActiveFile");

    // 4. Get the clipboard data after the API call
    const postAPICallClipboardData = await vscode.env.clipboard.readText();

    // 5. Return the saved original clipboard data to the clipboard so this method
    // will not interfere with the clipboard's content.
    await vscode.env.clipboard.writeText(originalClipboardData);

    // 6. Return the clipboard data from the API call (which could be an empty string if it failed).
    return postAPICallClipboardData;
};

// Returns the on-disk file:// Uri of the active editor. A staged diff's modified side uses the `git`
// scheme and encodes the real path in its JSON query (e.g. {"path":"/abs/path","ref":""}), so we
// normalize that back to a plain file Uri. Needed by the stage-and-advance command, which requires a
// filesystem path to stage and to match against the unstaged list.
const getActiveFileUri = async (): Promise<vscode.Uri | null> => {
    // PREFER the active TAB's diff (the same source getActiveChange + the badge use) over
    // vscode.window.activeTextEditor. Clicking a row in the Source Control panel makes its diff the active
    // TAB but leaves keyboard focus on the panel — so activeTextEditor stays undefined or stale (the
    // previously focused editor) and never registers the click. The tab-based lookup reflects the file you
    // actually clicked, keeping stage-and-advance in sync with it. BUG this fixes: click an unstaged file
    // then press stage-and-next and it jumped to the FIRST unstaged file instead of the one after the click —
    // because getActiveFileUri read activeTextEditor, so the clicked file wasn't found in the list (-1 ->
    // workingTreeChanges[0] top fallback). currentReviewFileUri already resolves a staged git: side to its
    // on-disk file: path, so this also handles a clicked staged row.
    const fromTab = currentReviewFileUri();
    if (fromTab) {
        return fromTab;
    }

    // Fallback: a plain (non-diff) text editor that genuinely has focus.
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) {
        if (uri.scheme === "git") {
            try {
                const params = JSON.parse(uri.query); // git uris carry {"path":"/abs/path","ref":...}
                if (params?.path) {
                    return vscode.Uri.file(params.path);
                }
            } catch {
                // Malformed/empty query — fall through and return the uri unchanged.
            }
        }
        return uri;
    }

    // Non-textual files (e.g. images) have no activeTextEditor; reuse the clipboard-based path lookup.
    const path = await getActiveFilePath();
    return path ? vscode.Uri.file(path) : null;
};

// Shared implementation for the smart mouse buttons. See the big comment at the smart-forward /
// smart-back command registrations for the full rationale on why we detect the diff via the active
// tab's input type (TabInputTextDiff) rather than the `isInDiffEditor` keybinding context.
//
// direction === "forward":  diff -> PREVIOUS SCM change (intentionally flipped) | otherwise -> navigateForward
// direction === "back":     diff -> NEXT SCM change (intentionally flipped)     | otherwise -> navigateBack
async function smartNavigate(direction: "forward" | "back") {
    let inDiff = false;
    try {
        // FOCUS-INDEPENDENT diff detection: read the active tab of the active group, not the focused editor.
        // This is what makes the mouse buttons "just work" even when focus is in the SCM panel during review.
        const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        // TabInputTextDiff is the input type VS Code uses for any side-by-side text diff tab (which is exactly
        // what `vscode.diff` opens). instanceof is safe even if `input` is undefined or some other type.
        inDiff = tab?.input instanceof vscode.TabInputTextDiff;
    } catch {
        // Defensive fallback: on a very old host where TabInputTextDiff doesn't exist the line above could
        // throw. Fall back to the legacy heuristic — treat it as a diff only if there's no plain active text
        // editor (a side-by-side diff has no single activeTextEditor in the classic sense). Worst case we
        // mis-route to plain navigation, which is the harmless default. TabInputTextDiff has been stable for
        // years so this branch should never actually run.
        inDiff = !vscode.window.activeTextEditor;
    }

    // NOTE: the DIFF branch is INTENTIONALLY flipped relative to the navigation branch (Ethan's preference,
    // 2026-06-20: "the diff one should be flipped, I know it's weird"). So the FORWARD button goes to the
    // PREVIOUS change while reviewing a diff, and the BACK button goes to the NEXT change. Outside a diff the
    // buttons keep their normal meaning (forward = navigateForward, back = navigateBack). Do not "correct" this.
    // The flip is a MOUSE-BUTTON preference only. It must never leak onto keyboard keys again: that's the
    // v1.2.5 QWERTY bug — these commands held the default alt+./alt+, (physical >/<) keyboard keys, so QWERTY
    // users got reversed >/< navigation while Dvorak (whose >/< keys type v/w -> next/previous-scm-change)
    // stayed correct. Keyboard >/< now binds the canonical scm-change commands directly in package.json.
    if (direction === "forward") {
        await vscode.commands.executeCommand(
            inDiff ? "better-git-vscode.previous-scm-change" : "workbench.action.navigateForward"
        );
    } else {
        await vscode.commands.executeCommand(
            inDiff ? "better-git-vscode.next-scm-change" : "workbench.action.navigateBack"
        );
    }
}

export function deactivate() {}
