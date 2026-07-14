import * as vscode from "vscode";
// fs + path are only used by resolveWorktreeRootUri's FALLBACK path (the filesystem `.git` walk used when the
// git extension API can't tell us which worktree owns a file). Node built-ins are available in the extension
// host — safe to import at top level.
import * as fs from "fs";
import * as path from "path";

// NOTE: the old `isNavigationPromptOpen` guard + the getNextFileName/getPreviousFileName helpers were
// removed in v1.0.2 along with the cross-file confirmation prompt — the tool now ALWAYS jumps silently.

// ──────────────────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGING — "Better Git" OutputChannel (v1.2.10)
//
// WHY this exists: the tall-hunk stepping logic (stepTallHunk) makes a viewport-derived decision on every
// next/previous-change press, and when it gets it wrong (e.g. the v1.2.9 stuck-near-the-bottom-of-a-tall-hunk
// bug) there was NO way to see WHY without re-deriving the geometry by hand from screenshots. This channel logs
// every step decision — direction, viewport height, hunk extent, top/bottom visible lines, caret, computed
// target, remaining lines, and the DECISION taken — so the NEXT stuck case is diagnosable instantly instead of
// guessed. Open it via View → Output → pick "Better Git" from the dropdown.
//
// Gated behind the `better-git-vscode.debugLogging` setting (default false) so it's silent for normal use and
// only writes when Ethan flips it on to diagnose something. The channel itself is created lazily on first log
// (so we don't allocate an Output channel for users who never enable logging) and reused thereafter.
let betterGitOutputChannel: vscode.OutputChannel | undefined;

// True only when the user has turned on verbose logging. Read live (not cached) so toggling the setting takes
// effect on the very next press without a reload.
const debugLoggingEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("debugLogging", false);

// Append one timestamped line to the "Better Git" output channel, but ONLY when debug logging is enabled.
// Lazily creates the channel on first use. Never throws (logging must never break navigation) — a failure to
// log is swallowed. Pass a short tag (e.g. "tall-hunk") + the human-readable message.
const debugLog = (tag: string, message: string): void => {
    try {
        if (!debugLoggingEnabled()) {
            return;
        }
        if (!betterGitOutputChannel) {
            betterGitOutputChannel = vscode.window.createOutputChannel("Better Git");
        }
        const ts = new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "";
        betterGitOutputChannel.appendLine(`[${ts}] [${tag}] ${message}`);
    } catch {
        // logging is best-effort telemetry — never let it interfere with the actual command
    }
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// LAST NAVIGATION DIRECTION (v1.2.7 — mouse-only stage-and-advance)
//
// WHY this exists (Ethan's exact problem): he wants to run the WHOLE review-and-stage flow with just the
// mouse. He clicks the editor-title "+" button to stage the current file, but then has to grab the
// keyboard to jump to the next change. The fix: make the "+" button stage AND advance — calling the EXACT
// same logic as the keyboard Shift+Alt+. / Shift+Alt+, (stageCurrentFileAndAdvance) — in whatever direction
// he was last navigating. So we remember the direction of his most recent "jump".
//
// WHICH commands count as "the last jump": his primary change-navigation keys — next/previous-scm-change
// (Alt+. / Alt+, on QWERTY, the headline > / < review keys) — plus the changed-FILE nav
// (next/previous-changed-file) and the stage-and-next/previous commands themselves. Rationale: from Ethan's
// POV "the last jump" is any deliberate forward-vs-backward move through the changeset, whether it stepped
// by hunk or by whole file; folding all of them in means the "+" button always advances the way he's
// currently working (top-to-bottom vs bottom-to-top) regardless of which nav key he last pressed. We do NOT
// track the smart mouse buttons here — their in-diff direction is intentionally FLIPPED (see smartNavigate)
// so their raw "forward"/"back" label doesn't map cleanly to review direction, and mixing them in would
// make the "+" advance the wrong way.
//
// Module-level (not inside activate) so both the nav command handlers and the new
// stage-current-file-and-advance command can read/write it. Defaults to "next" — a fresh session with no
// nav yet advances forward (top-to-bottom), which is the overwhelmingly common review order.
let lastNavDirection: "next" | "previous" = "next";

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

// The editor-title action row is inherently dynamic: VS Code adds/removes diff, revision, whitespace and
// layout buttons for different file states, so no menu order can keep the + at one exact pixel. The status
// bar is independent of editor type. This live setting gates a second click target there while preserving the
// existing editor-title + for users who like both.
const showStageAndAdvanceStatusBarEnabled = (): boolean =>
    vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("showStageAndAdvanceInStatusBar", true);

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
    // BUG 12 FIX (v1.2.9 — late worktree collapses hijacked the diff the user was actively reviewing): this
    // function runs on startup AND is re-fired (debounced) by onDidOpenRepository for ~12s as worktrees
    // populate in waves. The Step-2 reveal below re-uses the shared PREVIEW tab (showTextDocument preview:true),
    // so if the user has already navigated to a change in that preview tab, a late re-collapse would replace
    // their current diff with the primary's first change out from under them. Guard: if a change-review tab is
    // already active (currentReviewFileUri — the SAME shared "which file is under review" predicate the nav +
    // badge use — resolves to a file), the user is mid-review, so SKIP the reveal. Their own navigation keeps
    // firing SCM auto-reveal (expandTo) on whatever they open, so the primary re-expands the next time they
    // land on one of its files — without us hijacking their diff. The FIRST startup collapse has no review open
    // yet (currentReviewFileUri undefined), so it still lands on the primary's first change exactly as before.
    if (currentReviewFileUri() !== undefined) {
        return;
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

// The auto-on-startup routine. Gated by the `collapseWorktreesOnStartup` setting (default FALSE — opt-in;
// changed from true in v1.2.12) and by there being ≥2 repositories (a single repo isn't the "lots of expanded
// worktrees" annoyance, and we don't want to steal focus / hide the only repo's changes for it). Because repos
// populate async, we POLL for them, then collapse. We ALSO briefly watch `onDidOpenRepository` so worktrees
// that finish opening AFTER our first collapse still get folded — but only within a short startup window, so
// opening a repo later in the session (deliberately) never yanks its section closed under the user.
const runCollapseWorktreesOnStartup = (context: vscode.ExtensionContext): void => {
    // Fallback matches the package.json default (false): off by default, opt-in only. The manual
    // 'collapse-worktrees' command still works regardless of this setting.
    const enabled = vscode.workspace
        .getConfiguration("better-git-vscode")
        .get<boolean>("collapseWorktreesOnStartup", false);
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
            // v1.2.11 — RELIABLE COLLAPSE ON EXTENSION-HOST RESTART. activate() re-runs on "Developer: Restart
            // Extension Host", so this routine already fires then — BUT on a restart the SCM view is
            // simultaneously re-rendering from its persisted state and can RE-EXPAND the sections a beat after
            // our single collapse lands, silently undoing it (Ethan: "on restart of extensions also make it run
            // the collapse"). Fix: re-fire the collapse a few times over the first ~1.6s to win that race so the
            // fold sticks. Re-collapsing already-collapsed sections is a harmless no-op, and the Bug-12
            // review-in-flight guard inside collapseWorktreesKeepingPrimaryExpanded still prevents any diff
            // hijack on the re-expand step, so these repeats can't yank a diff out from under a mid-review user.
            for (const delayMs of [300, 800, 1600]) {
                const t = setTimeout(() => void collapseWorktreesKeepingPrimaryExpanded(), delayMs);
                context.subscriptions.push(new vscode.Disposable(() => clearTimeout(t)));
            }
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
    // Persistent fixed-location mouse target for stage-and-advance (v1.2.20). Priority 101 places it directly
    // beside, and just before, the existing last-staged indicator at priority 100. Unlike editor/title, this
    // row does not gain/lose controls when the active file switches between modified/new/staged diff shapes.
    // It deliberately remains visible on every editor: the shared command safely no-ops when no changed file
    // is active, and a never-moving target is the whole point of this alternative.
    const stageAndAdvanceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    stageAndAdvanceStatusBarItem.text = "$(add) Stage & Next";
    stageAndAdvanceStatusBarItem.tooltip = "Better Git: stage the current changed file and advance in the last navigation direction";
    stageAndAdvanceStatusBarItem.command = "better-git-vscode.stage-current-file-and-advance";
    if (showStageAndAdvanceStatusBarEnabled()) {
        stageAndAdvanceStatusBarItem.show();
    }

    // Create the last-staged status bar item. Left alignment + priority 100 puts it on the left cluster at a
    // reasonable position. Starts HIDDEN — there's nothing to show until the first stage of the session. Its
    // .command points at our reveal command (registered below) so a click reopens the staged file's diff.
    lastStagedStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    lastStagedStatusBarItem.command = "better-git-vscode.reveal-last-staged-file";
    lastStagedStatusBarItem.hide();
    // Every forward nav command records lastNavDirection = "next"; every backward one records "previous".
    // This is what the editor-title "+" button reads to decide which way to advance after staging (v1.2.7).
    let disposable = vscode.commands.registerCommand("better-git-vscode.next-scm-change", async () => {
        lastNavDirection = "next"; // he just jumped FORWARD through changes -> "+" should advance forward
        await goToNextDiff();
    });

    let disposable2 = vscode.commands.registerCommand("better-git-vscode.previous-scm-change", async () => {
        lastNavDirection = "previous"; // he just jumped BACKWARD -> "+" should advance backward
        await goToPreviousDiff();
    });

    let disposable3 = vscode.commands.registerCommand("better-git-vscode.next-changed-file", async () => {
        lastNavDirection = "next";
        await goToFirstOrNextFile();
    });

    let disposable4 = vscode.commands.registerCommand("better-git-vscode.previous-changed-file", async () => {
        lastNavDirection = "previous";
        await goToLastOrPreviousFile();
    });

    let disposable5 = vscode.commands.registerCommand("better-git-vscode.revert-and-save", async () => {
        await vscode.commands.executeCommand("git.revertSelectedRanges");
        await vscode.commands.executeCommand("workbench.action.files.save");
    });

    // The keyboard stage-and-advance commands also count as a "jump" — pressing shift+alt+. means Ethan is
    // reviewing top-to-bottom, so the "+" button should keep advancing forward after this, and vice versa.
    let disposable6 = vscode.commands.registerCommand("better-git-vscode.stage-and-next-changed-file", async () => {
        lastNavDirection = "next";
        await stageCurrentFileAndAdvance("next");
    });

    // Mirror of disposable6 for reverse-order (bottom-to-top) review: stage the current file, then jump to the
    // PREVIOUS unstaged file instead of the next. Bound to "shift + previous" so it parallels "shift + next".
    let disposable7 = vscode.commands.registerCommand("better-git-vscode.stage-and-previous-changed-file", async () => {
        lastNavDirection = "previous";
        await stageCurrentFileAndAdvance("previous");
    });

    // Legacy command: stage the current file WITHOUT navigating. Kept registered so anyone who bound it keeps
    // that behaviour, but as of v1.2.7 it is NO LONGER what the editor-title "+" button runs — the button now
    // runs stage-current-file-and-advance (disposable15 below) for the mouse-only review flow.
    let disposable8 = vscode.commands.registerCommand("better-git-vscode.stage-current-file", async () => {
        await stageCurrentFile();
    });

    // Editor-title "+" button (v1.2.7): stage the current file AND advance to the next/previous change in
    // whatever direction Ethan last navigated (lastNavDirection). This lets him run the whole review-and-stage
    // flow with the mouse alone — click "+" to stage-and-jump instead of clicking "+" then reaching for the
    // keyboard. It calls the EXACT SAME stageCurrentFileAndAdvance() that Shift+Alt+. / Shift+Alt+, use, so
    // behaviour (staging, advance target, cross-file rollover, last-staged status bar) is byte-identical to the
    // keyboard shortcut. On a non-diff / non-change editor stageCurrentFileAndAdvance safely no-ops (its
    // isChangedFile guard), so the button never errors even when "advance" is meaningless.
    let disposable15 = vscode.commands.registerCommand("better-git-vscode.stage-current-file-and-advance", async () => {
        await stageCurrentFileAndAdvance(lastNavDirection);
    });

    // Manual trigger for collapsing the worktree/repository section headers (see the big comment block
    // above `activate`). Ethan can bind this to a key or run it from the palette any time the worktree
    // sections have crept back open. v1.2.13: this is now a PLAIN collapse-all — it folds EVERY repo section
    // (including the primary/main one) and does NOT re-expand the primary afterward. Ethan explicitly asked
    // for this ("just do the normal collapse"): the old keep-primary-expanded behaviour re-opened the
    // primary's first change in a PREVIEW TAB to re-reveal it, and that tab popping open was annoying. A
    // plain collapse has none of that. (The auto-on-startup path still keeps the primary expanded for anyone
    // who turns collapseWorktreesOnStartup on — only this explicit command is a plain collapse.) No ≥2-repo
    // gate — if you ask for it explicitly, we act on whatever's there.
    let disposable14 = vscode.commands.registerCommand("better-git-vscode.collapse-worktrees", async () => {
        await collapseScmRepositories();
    });

    // ADD-CURRENT-WORKTREE-TO-WORKSPACE (v1.2.14). Pull the git worktree that the currently-open/under-review
    // file lives in into the VS Code workspace as a workspace folder, so Ethan can bring a worktree into his
    // sidebar without leaving the editor. Handler flow is: resolve the file -> resolve its worktree root ->
    // dedupe against existing folders -> add. See the ext-host-restart caveat at the add call (it MUST be last).
    let disposable16 = vscode.commands.registerCommand("better-git-vscode.add-current-worktree-to-workspace", async () => {
        // 1. Which file are we acting on? Prefer the SHARED "file under review" predicate (currentReviewFileUri
        //    handles diff / merge / new-file / deleted / binary review tabs, and — crucially for Ethan's flow —
        //    still resolves when keyboard focus is in the SCM panel so activeTextEditor is stale/undefined). Fall
        //    back to the focused text editor for a plainly-opened file.
        const fileUri = currentReviewFileUri() ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showInformationMessage("Better Git: No active file to resolve a git worktree from.");
            return;
        }
        // Normalise any diff-side / git: uri to the on-disk file path before we look up its repo.
        const onDiskUri = toFilePathUri(fileUri);
        if (!onDiskUri) {
            vscode.window.showInformationMessage("Better Git: Couldn't resolve the current file to a path on disk.");
            return;
        }
        // 2. Resolve the worktree root the file belongs to (git API primary, .git-walk fallback). Not in any git
        //    repo -> info message + return (NOT an error — this is a valid, expected situation).
        const worktreeRoot = resolveWorktreeRootUri(onDiskUri);
        if (!worktreeRoot) {
            vscode.window.showInformationMessage("Better Git: The current file isn't inside a git repository / worktree.");
            return;
        }
        // 3. Add it as a workspace folder — THE LAST THING THIS HANDLER DOES (see caveat below). The shared
        //    helper also dedupes roots and owns every user-facing success/failure/restart message.
        //
        // ── EXTENSION-HOST-RESTART CAVEAT (VS Code docs for workspace.updateWorkspaceFolders) ────────────────
        // Adding the FIRST extra folder to a SINGLE-FOLDER window transitions it to a MULTI-ROOT workspace,
        // which RESTARTS the extension host. When that happens updateWorkspaceFolders() may return BEFORE any
        // code after it runs (the host is being torn down), so the add MUST be the LAST statement in this
        // handler and we must NOT depend on its return value in that transition. We DO still honour the return
        // value in the non-transition case (adding to an already-multi-root workspace does NOT restart the host,
        // so `false` there genuinely means the add failed). `willBecomeMultiRoot` distinguishes the two: exactly
        // one existing folder AND no .code-workspace file open == the single→multi transition that restarts.
        addWorktreeRootToWorkspace(worktreeRoot, true);
        // NOTHING AFTER THIS POINT — the ext-host restart (single→multi transition) can cut the handler off here.
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
    // THAT. If its git worktree is not already an Explorer workspace folder, add that root first — Explorer
    // cannot reveal out-of-workspace files. Bind to cmd+shift+e (when: isInDiffEditor) to make reveal work from
    // staged diffs. Works from unstaged diffs and plain editors too (getActiveFileUri handles all three).
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
        // OPEN FIRST. Usually the reveal follows immediately, but adding the first extra workspace folder can
        // restart the extension host. Opening first makes that transition safe: the real editable file survives
        // the quick reload and VS Code auto-reveals it once its newly-added worktree root appears in Explorer.
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

        // Explorer has no node for a file outside all workspace roots. Resolve its owning git worktree and add
        // that root automatically, reusing the same implementation as the explicit Command Palette action.
        if (!vscode.workspace.getWorkspaceFolder(uri)) {
            const autoAddWorktree = vscode.workspace
                .getConfiguration("better-git-vscode")
                .get<boolean>("autoAddWorktreeOnReveal", true);
            if (!autoAddWorktree) {
                vscode.window.showInformationMessage(
                    "Better Git: Opened the file, but its worktree isn't in the workspace and auto-add on reveal is turned off."
                );
                return;
            }
            const worktreeRoot = resolveWorktreeRootUri(uri);
            if (!worktreeRoot) {
                vscode.window.showInformationMessage(
                    "Better Git: Opened the file, but it isn't inside a workspace folder or git worktree to reveal."
                );
                return;
            }
            // Subscribe BEFORE updateWorkspaceFolders: workspaceFolders can reflect the new root synchronously
            // while Explorer's change event is still queued, and subscribing afterward can miss that event.
            const workspaceFolderReady = waitForFileWorkspaceFolder(uri);
            const addResult = addWorktreeRootToWorkspace(worktreeRoot, false);
            if (addResult === "failed" || addResult === "restart-expected") {
                return; // restart path continues via VS Code's normal active-file auto-reveal after reload
            }
            if (addResult === "added") {
                await workspaceFolderReady;
            }
        }

        // The file now has an Explorer node, so select it. Opening happened above because reveal alone only
        // highlights the tree node; this command promises both a normal editable file and its Explorer location.
        await vscode.commands.executeCommand("revealInExplorer", uri);
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
        if (e.affectsConfiguration("better-git-vscode.showStageAndAdvanceInStatusBar")) {
            if (showStageAndAdvanceStatusBarEnabled()) {
                stageAndAdvanceStatusBarItem.show();
            } else {
                stageAndAdvanceStatusBarItem.hide();
            }
        }
        if (e.affectsConfiguration("better-git-vscode.showLastStagedInStatusBar") && lastStagedStatusBarItem) {
            if (showLastStagedEnabled() && lastStagedUri) {
                recordLastStaged(lastStagedUri); // re-render + show with the file we last staged
            } else {
                lastStagedStatusBarItem.hide();
            }
        }
    });

    // Kick off the collapse-worktrees-on-startup routine (gated by setting + ≥2 repos). This is async and
    // self-tearing-down; it does NOT block activation. See the big comment block above `activate` for the
    // timing/populate + reveal-SCM caveats.
    runCollapseWorktreesOnStartup(context);

    context.subscriptions.push(
        disposable, disposable2, disposable3, disposable4, disposable5, disposable6, disposable7, disposable8,
        disposable9, disposable10, disposable11, disposable12, disposable13, disposable14, disposable15,
        disposable16, // add-current-worktree-to-workspace (v1.2.14)
        stageAndAdvanceStatusBarItem, // fixed-location Stage & Next mouse target (v1.2.20)
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
        // mergeChanges (unresolved conflicts) counts as a change too (Codex review 2026-07-04): with the
        // DEFAULT git.mergeEditor=false a conflict opens as the plain working file, and this shared "is this a
        // change?" predicate feeds currentReviewFileUri's plain/custom branches — so without mergeChanges a
        // plain merge-conflict tab was invisible to repo-selection, the late-collapse guard, and the badge.
        return (
            inAny(repo.state.indexChanges) ||
            inAny(repo.state.workingTreeChanges) ||
            inAny(repo.state.untrackedChanges) ||
            inAny(repo.state.mergeChanges)
        );
    } catch {
        return false; // git extension not ready / API shape changed — just don't badge
    }
};

// TRUE only when `uri` is specifically an UNRESOLVED MERGE CONFLICT (in repo.state.mergeChanges). Distinct
// from isChangeFileUri (which is true for any change) because the smart-mouse gate must treat a plain
// merge-conflict working-file editor as review WITHOUT also treating an ordinary modified file opened in a
// plain editor as review — the latter is deliberately excluded from mouse change-nav so thumb-Back keeps its
// normal browser-history meaning while you're editing. (Codex review 2026-07-04, plain-merge follow-up.)
const isMergeConflictFileUri = (uri: vscode.Uri): boolean => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(uri) ?? git?.repositories?.[0];
        if (!repo) {
            return false;
        }
        const p = uri.path.toLowerCase();
        return (repo.state.mergeChanges ?? []).some((c: any) => c.uri.path.toLowerCase() === p);
    } catch {
        return false; // git extension not ready / API shape changed
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

// Resolve the git WORKTREE ROOT that a given on-disk file belongs to, returned as a folder file: uri (v1.2.14).
//
// PRIMARY path — the git extension's Repository model. `git.getRepository(uri)` returns the Repository whose
// working tree contains `uri`, and the git extension treats EACH linked worktree as its OWN Repository — so
// `repo.rootUri` IS that worktree's root directory (NOT the shared/main clone). That's exactly what "add the
// worktree this file lives in" means, so we prefer it. This is the SAME git API + getRepository lookup that
// isChangeFileUri/isMergeConflictFileUri already use, so we stay consistent with how the rest of the extension
// maps a file to its repo.
//
// FALLBACK — if the git extension isn't ready yet, or doesn't yet know about this file's repo, walk UP the
// directory tree from the file until we hit a `.git` marker. Note a linked worktree's marker is a `.git` FILE
// (containing `gitdir: …/.git/worktrees/<name>`), not a directory — `fs.existsSync` matches either, and we
// return the directory that CONTAINS the marker (that dir is the worktree root). Returns undefined only when
// the file is inside no git repository at all (caller then shows an info message, never an error).
const resolveWorktreeRootUri = (fileUri: vscode.Uri): vscode.Uri | undefined => {
    // PRIMARY — ask the git extension which repository/worktree owns this file.
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(fileUri);
        if (repo?.rootUri) {
            return repo.rootUri as vscode.Uri; // each worktree is its own Repository -> rootUri = worktree root
        }
    } catch {
        // git API not ready / shape changed — fall through to the filesystem walk below.
    }
    // FALLBACK — walk parent dirs looking for a `.git` marker (a dir for a normal clone, a FILE for a worktree).
    try {
        let dir = path.dirname(fileUri.fsPath);
        // Loop guard: stop when dirname stops changing (we've hit the filesystem root and can climb no further).
        for (let prev = ""; dir && dir !== prev; prev = dir, dir = path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, ".git"))) {
                return vscode.Uri.file(dir); // this dir contains the .git marker -> it's the worktree root
            }
        }
    } catch {
        // fs error (permissions etc.) — give up; caller treats undefined as "not in a git repo".
    }
    return undefined;
};

// Add one resolved git worktree root to Explorer and report what happened. This is shared by the explicit
// "Add current worktree" command and reveal-current-file: revealing a file outside every workspace folder is
// impossible because Explorer has no tree node for it, so reveal now pulls that worktree into the workspace
// automatically instead of silently no-oping.
//
// IMPORTANT: a single-folder -> multi-root transition restarts the extension host. Callers must do anything
// that has to survive that transition BEFORE calling this helper. reveal-current-file therefore opens the real
// working file first; VS Code preserves that active editor across the quick restart and Explorer's normal
// auto-reveal selects it once the new worktree root exists.
const addWorktreeRootToWorkspace = (
    worktreeRoot: vscode.Uri,
    showAlreadyPresentMessage: boolean
): "already-present" | "added" | "restart-expected" | "failed" => {
    const name = path.basename(worktreeRoot.fsPath) || worktreeRoot.fsPath;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some((folder) => sameRootPath(folder.uri, worktreeRoot))) {
        if (showAlreadyPresentMessage) {
            vscode.window.showInformationMessage(`Better Git: "${name}" is already in the workspace.`);
        }
        return "already-present";
    }

    // VS Code restarts the extension host when an ordinary single-folder window becomes multi-root. A saved
    // .code-workspace already has stable workspace identity, so adding its second folder does not use this path.
    const willBecomeMultiRoot = folders.length === 1 && !vscode.workspace.workspaceFile;
    if (willBecomeMultiRoot) {
        vscode.window.showInformationMessage(
            `Better Git: Adding worktree "${name}" — this window becomes a multi-root workspace (quick reload).`
        );
    }
    try {
        const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: worktreeRoot, name });
        // During the single-folder -> multi-root transition the host can start restarting before the return
        // value is trustworthy. Preserve the explicit command's established behaviour: only treat false as a
        // real failure when no restart is expected.
        if (!ok && !willBecomeMultiRoot) {
            vscode.window.showErrorMessage(`Better Git: Failed to add worktree "${name}" to the workspace.`);
            return "failed";
        }
        return willBecomeMultiRoot ? "restart-expected" : "added";
    } catch (e) {
        vscode.window.showErrorMessage(`Better Git: Failed to add worktree to the workspace: ${e}`);
        return "failed";
    }
};

// updateWorkspaceFolders starts an asynchronous Explorer-model update. Wait for the target file to acquire a
// workspace folder before asking revealInExplorer to select it; otherwise a fast reveal can race the new root
// and reproduce the same silent no-op this feature fixes. The timeout is only a safety valve — after it we still
// attempt the reveal, because the folder update may have completed without delivering an event to this host.
const waitForFileWorkspaceFolder = async (fileUri: vscode.Uri, timeout = 2000): Promise<void> => {
    if (vscode.workspace.getWorkspaceFolder(fileUri)) {
        return;
    }
    await new Promise<void>((resolve) => {
        let listener: vscode.Disposable | undefined;
        const timer = setTimeout(() => {
            listener?.dispose();
            resolve();
        }, timeout);
        listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (!vscode.workspace.getWorkspaceFolder(fileUri)) {
                return;
            }
            clearTimeout(timer);
            listener?.dispose();
            resolve();
        });
    });
};

// SHARED merge-editor predicate (v1.2.9). A 3-way MERGE editor (git conflict) is a TabInputTextMerge tab.
// That type exists at runtime but isn't in this project's @types/vscode (1.83), so we duck-type it by shape:
// a merge input uniquely has `result` (the on-disk file being merged) + `input1` + `input2` (the two sides).
// This exact duck-type used to be copy-pasted in THREE places (currentReviewFileUri, getActiveChange, and it
// was MISSING from the smart-mouse gate — Bug 1, 2026-07-04: the mouse fell through to browser nav on a merge
// conflict while the keyboard navigated the changeset). Extracted to ONE predicate so every entry point that
// needs to recognise "is this the merge-conflict editor?" asks the SAME question — the mouse can't diverge
// from the keyboard on merge conflicts again. Returns true only for a genuine merge tab (all three fields).
const isMergeEditorInput = (input: unknown): boolean => {
    const m = input as any;
    return !!(m && m.result && m.input1 && m.input2);
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
    // A 3-way MERGE editor (git conflict) — recognised via the shared isMergeEditorInput predicate. `result`
    // is the on-disk file being merged. The TabInputTextDiff check above already ran, so this is unambiguous.
    if (isMergeEditorInput(input)) {
        return toFilePathUri((input as any).result);
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
    // A BINARY / IMAGE change opens as a custom editor (TabInputCustom) — git.openChange renders it via a
    // custom editor, NOT a text diff/editor (Codex review 2026-07-04, follow-up to the smart-mouse BUG 2).
    // Without this branch the shared "which file is under review?" predicate missed binary/image review tabs,
    // so repo selection (getFileChanges) and the late-worktree-collapse protection could pick the wrong repo
    // or yank you off a binary/image diff. Resolve the custom tab's on-disk uri and accept it only when it's an
    // ACTUAL change, using the SAME toFilePathUri + isChangeFileUri predicates the smart-mouse gate uses.
    if (input instanceof vscode.TabInputCustom) {
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
    // BUG 10 FIX (v1.2.9 — getFileChanges threw instead of no-oping when git wasn't ready / no repos):
    // the old code did `getExtension("vscode.git")!.exports` (`.exports` is undefined until the git extension
    // ACTIVATES, so `.getAPI(1)` threw TypeError) and then `git.repositories[0]` + unguarded `activeRepo.state`
    // (undefined when repositories is [] — fresh window still scanning, or a non-git workspace). The command
    // promise rejected, so a nav/reveal keypress did nothing AND no fallback ran (openFirst/openLast threw
    // before reaching their length===0 guard). Now we use the SAME guarded `?.exports?.getAPI(1)` form as
    // every other git-touching helper in this file and return [] on any miss so every caller no-ops cleanly.
    const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
    if (!git) {
        return []; // git extension not present / not activated yet -> no changes, callers no-op gracefully
    }
    const workspaceUri = vscode.workspace.workspaceFolders?.map((ws) => ws.uri)[0];
    // Prefer the repo that owns the file CURRENTLY BEING REVIEWED (tab-derived, focus-independent) so a
    // multi-root workspace navigates within the right repo — falling through from a file in repo B used to
    // build repo A's list, miss the file (findCurrentIndex -1) and silently stop (Codex review, v1.2.1).
    // Fall back to the first workspace folder's repo, then the shared getPrimaryRepository() (the same
    // "pick the primary repo" predicate the worktree-collapse uses) instead of a raw git.repositories[0]
    // that could be undefined. Null-check the result so a still-scanning window returns [] rather than throws.
    const reviewUri = currentReviewFileUri();
    const activeRepo =
        (reviewUri && git.getRepository(reviewUri)) || git.getRepository(workspaceUri?.path) || getPrimaryRepository();
    if (!activeRepo) {
        return []; // no repositories populated yet / non-git workspace -> no changes, callers no-op gracefully
    }
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
    // 3-way merge editor (conflict) — recognised via the shared isMergeEditorInput predicate. `result` is the
    // working-tree file. Treat as the unstaged side for matching (a conflict is never a "staged" view here).
    if (isMergeEditorInput(input)) {
        return { path: (input as any).result.path as string, staged: false };
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
            // BUG 9 FIX (v1.2.9 — dual-state DELETED file dead-ended navigation): return staged=FALSE here, not
            // staged=null. Rationale: EVERY staged/index side in this extension opens as a side-by-side
            // TabInputTextDiff (openChangeEntry always uses vscode.diff for the staged branch), so a PLAIN
            // single-editor active view is ALWAYS the working-tree/unstaged representation — an untracked file
            // (file: editor) or a deleted file's HEAD-blob (git: editor). Labelling it staged=null forced
            // findCurrentIndex down its path-only branch, where the AMBIGUITY GUARD (path appears in BOTH the
            // staged + unstaged groups) permanently returned -1 for a dual-state deleted/untracked file — and a
            // deleted file NEVER opens as a readable diff, so the side stayed null forever and next/previous
            // nav was hard-stuck with no recovery. With staged=false, findCurrentIndex's exact {path, staged}
            // match resolves the file to its unstaged entry and the guard never fires. Safe for single-state
            // files too: a staged-only file shown as a plain editor fails the exact staged=false match but the
            // path appears once, so the guard doesn't fire and the path-only fallback still finds it.
            return { path: resolved.path, staged: false };
        }
    }

    // Fallback for genuinely non-textual files (images etc.): path only, side unknown. This is now the ONLY
    // path that yields staged=null, so the findCurrentIndex ambiguity guard below only ever gates images.
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
        // active tab actually shows the requested file now; if not, open it directly.
        // CODEX FIX 2026-07-04 (High): resolve the shown file via the SHARED currentReviewFileUri() predicate,
        // NOT a local diff/plain-text-only copy. git.openChange legitimately opens a merge conflict as a 3-way
        // merge editor and a binary/image change as a custom editor — neither is a TabInputTextDiff/TabInputText,
        // so the old local check saw "no match" and fell back to showTextDocument(entry.uri), which REPLACED the
        // correct merge/binary view with the raw file (defeating the very merge/binary handling this batch added).
        // currentReviewFileUri now recognises diff + plain + merge + custom (binary/image) tabs, so the fallback
        // fires ONLY when the target genuinely didn't open. The common modified-diff path is unchanged (its
        // TabInputTextDiff branch returns the modified-side path exactly as the old local copy did).
        const shownUri = currentReviewFileUri();
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
        // v1.2.17 no-context pick: a clean repo is a normal end state after stage-and-advance, not an error.
        // Keep the feedback quiet in the status bar (never a popup that interrupts the review flow), while
        // still making the otherwise-empty keypress explain itself to the user and the debug output channel.
        debugLog("nav", "next: no active file context -> no changes to navigate");
        vscode.window.setStatusBarMessage("Better Git: No changes to navigate", 4000);
        return;
    }

    // v1.2.17 no-context pick: start with WORKING-TREE work (merge conflicts + unstaged/untracked entries)
    // because that is the actionable review queue. Only after stage-and-advance has staged everything do we
    // continue through the index diff — picking staged work is the useful continuation instead of dead-ending.
    const unstagedChanges = fileChanges.filter((entry) => !entry.staged);
    const target = unstagedChanges[0] ?? fileChanges.find((entry) => entry.staged)!;
    debugLog(
        "nav",
        unstagedChanges.length > 0
            ? "next: no active file context -> picking first changed file (unstaged-first)"
            : "next: no active file context -> no unstaged changes; picking first staged file",
    );
    await openChangeEntry(target);
};

const openLastFile = async () => {
    const shouldOpenScmView = vscode.workspace.getConfiguration("better-git-vscode").get("shouldOpenScmView");
    if (shouldOpenScmView) {
        await vscode.commands.executeCommand("workbench.view.scm");
    }

    const fileChanges = await getFileChanges();
    if (fileChanges.length === 0) {
        // Mirror openFirstFile: reaching a clean repo backward is expected after staging the final file, so use
        // the same quiet status-bar acknowledgement rather than an error/warning popup.
        debugLog("nav", "previous: no active file context -> no changes to navigate");
        vscode.window.setStatusBarMessage("Better Git: No changes to navigate", 4000);
        return;
    }

    // v1.2.17 no-context pick: backward entry uses the LAST actionable working-tree item, falling back to the
    // LAST staged/index item only when staging everything emptied that queue. Preserve getFileChanges order
    // within each side so this still follows the SCM view's merge/index/working-tree sorting conventions.
    const unstagedChanges = fileChanges.filter((entry) => !entry.staged);
    const stagedChanges = fileChanges.filter((entry) => entry.staged);
    const target = unstagedChanges[unstagedChanges.length - 1] ?? stagedChanges[stagedChanges.length - 1];
    debugLog(
        "nav",
        unstagedChanges.length > 0
            ? "previous: no active file context -> picking last changed file (unstaged-first)"
            : "previous: no active file context -> no unstaged changes; picking last staged file",
    );
    await openChangeEntry(target);
    // Symmetric with openPreviousFile (v1.2.15): openLastFile is only ever reached via a BACKWARD entry
    // (pressing previous when nothing is under review wraps to the LAST file — see goToPreviousDiff /
    // goToLastOrPreviousFile). If that last file is a genuinely-new plain-editor file, land at its BOTTOM so the
    // NEXT 'previous' press steps UP through it instead of seeing top<=0 and skipping the whole file unseen (the
    // exact BUG 5 class of bug, previously only fixed for openPreviousFile — Codex xhigh flagged the asymmetry).
    if (await landNewFileTargetAtBottom(target)) {
        return;
    }
    // v1.2.17 mirror landing: a modified/staged diff selected by a backward no-context entry must land at its
    // LAST hunk, just like openPreviousFile rollover. Forward entry needs no command because opening naturally
    // starts at the first hunk; backward entry explicitly asks VS Code for the previous (last) change.
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
};

// Shared backward-rollover landing (v1.2.15): when a BACKWARD navigation opens a genuinely-new, UNSTAGED,
// plain-editor file, scroll it to show its BOTTOM (and pin the caret at the last line) so the subsequent
// 'previous' press steps UP through it. Factored out of openPreviousFile so openLastFile can reuse the exact
// same retry+landing logic (Codex xhigh: "factor the retry/landing block into one small helper").
//
// WHY the bottom landing (BUG 5, v1.2.9): a MODIFIED file lands at its LAST hunk on backward rollover (via
// compareEditor.previousChange), so subsequent 'previous' presses step UP through it. But that command is a
// NO-OP on a genuinely-new file's PLAIN editor (no diff hunks), leaving the view at the TOP — and since
// stepThroughNewFile is now viewport-derived (v1.2.15), a viewport at the top means the next 'previous' press
// sees top<=0 and advances to the file BEFORE it, skipping the new file's content unseen. Landing at the bottom
// makes the next 'previous' start stepping up from the end.
//
// WHY the !staged gate (Codex fix 2026-07-04): isFullyAddedFile is also true for a STAGED-new file
// (INDEX_ADDED), but openChangeEntry opens a staged entry as a side-by-side DIFF, not a plain new-file editor —
// so newFileScrollEditor() would never resolve; we'd burn the retry loop for nothing then swallow the
// compareEditor.previousChange landing. Gating on !staged keeps this to the plain-editor (untracked/unstaged-new)
// case; a staged-new target returns false so the caller falls through to its diff landing.
//
// Returns true if the target was recognised as a new-file (plain-editor) target — the caller must then NOT run
// compareEditor.previousChange. Returns false for a non-new / staged target so the caller handles it normally.
const landNewFileTargetAtBottom = async (entry: FileChange): Promise<boolean> => {
    if (entry.staged || !isFullyAddedFile(entry.uri)) {
        return false; // modified / deleted / staged-new target -> caller takes the normal diff path
    }
    // The plain editor may not register in visibleTextEditors synchronously after openChangeEntry, so retry the
    // gate for a few short ticks. Reuses newFileScrollEditor() (plain file: tab + genuinely-new status + visible
    // editor) — the exact gate the in-file new-file stepping uses.
    let newFileEditor: vscode.TextEditor | undefined;
    for (let i = 0; i < 8 && !newFileEditor; i++) {
        newFileEditor = newFileScrollEditor();
        if (!newFileEditor) {
            await new Promise((r) => setTimeout(r, 30)); // wait one short tick for the editor to become visible
        }
    }
    if (newFileEditor) {
        // revealBottomAndPinCursor uses RevealType.Default, which brings an off-screen-below line into view at
        // the BOTTOM and is NEVER EOF-clamped (unlike InCenter on the last line), so the bottom shows reliably.
        const lastLine = Math.max(0, newFileEditor.document.lineCount - 1);
        revealBottomAndPinCursor(newFileEditor, lastLine);
    }
    // If the editor never resolved (rare race) we still return true (it IS a new-file target) — the view stays
    // at the top, the same no-op the old unconditional compareEditor.previousChange produced on a plain new file.
    return true;
};

const openNextFile = async () => {
    const fileChanges = await getFileChanges();

    const active = await getActiveChange();
    if (!active) {
        // v1.2.17 no-context pick: with no active file there is nothing to advance FROM, so choose the first
        // changed file instead. Crucially this returns before the normal isPreview/closeActiveEditor block:
        // starting a review must never close whatever non-review tab/editor the user currently has open.
        await openFirstFile();
        return;
    }

    if (fileChanges.length === 0) {
        // A clean/settings tab can still produce an ActiveChange-shaped path even though the repo has no
        // entries. Reuse the v1.2.17 first-entry path so this clean-repo case gets the same quiet status-bar
        // feedback and debug log instead of preserving the old silent return.
        await openFirstFile();
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        const normalized = active.path.slice(1).replace(/\\/g, "/").toLowerCase();
        const activePathExists = fileChanges.some((entry) => entry.uri.path.toLowerCase().endsWith(normalized));
        if (!activePathExists) {
            // v1.2.17 no-context pick: a clean/settings/other non-change tab is context for VS Code, but not
            // for change navigation. Pick the first change without closing that active editor (openFirstFile
            // intentionally only opens the target). This is the common post-stage-everything focus state.
            await openFirstFile();
            return;
        }
        // AMBIGUITY GUARD MUST KEEP BAILING: findCurrentIndex also returns -1 when a side-unknown file exists
        // in BOTH staged and unstaged groups. activePathExists distinguishes that uncertainty from a genuine
        // no-match; guessing here previously flung navigation to the wrong end of the list. A re-press works
        // once VS Code exposes the diff side, so preserve the safe no-op for this distinct -1 meaning.
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
        // v1.2.17 no-context pick: mirror forward entry by selecting the last change, and return before the
        // normal closeActiveEditor path so starting backward review never destroys the user's current tab.
        await openLastFile();
        return;
    }

    if (fileChanges.length === 0) {
        // Mirror forward navigation: an active non-change tab in a clean repo is still "no review context".
        // Route through openLastFile for the shared status-bar acknowledgement rather than silently no-oping.
        await openLastFile();
        return;
    }
    const currentIndex = findCurrentIndex(fileChanges, active);
    if (currentIndex === -1) {
        const normalized = active.path.slice(1).replace(/\\/g, "/").toLowerCase();
        const activePathExists = fileChanges.some((entry) => entry.uri.path.toLowerCase().endsWith(normalized));
        if (!activePathExists) {
            // A non-change active tab supplies no review position. Pick the last unstaged-first target via the
            // shared backward entry path, which also handles bottom/last-hunk landing and never closes this tab.
            await openLastFile();
            return;
        }
        // BUG FIX (intermittent "previous jumps to the last staged change"): the old code did
        // `currentIndex <= 0 ? last : currentIndex - 1`, which treated "not found" (-1) the SAME as "at the
        // first file" (0) and wrapped to the LAST file. When the diff side wasn't readable for a dual-state
        // file, findCurrentIndex returned -1 and "previous" lurched to the last change. Now we bail on -1;
        // the next press (once the diff tab is readable) navigates correctly. Genuine index 0 still loops.
        // v1.2.17: activePathExists above preserves this ambiguity guard while routing ONLY true path misses
        // (clean/settings/non-change tabs) to the friendly no-context picker.
        return;
    }

    // LOOP: wrap to the last file only when genuinely at the first file (index 0).
    const prevIndex = currentIndex === 0 ? fileChanges.length - 1 : currentIndex - 1;

    const isPreview = vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview;
    if (!isPreview) {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await openChangeEntry(fileChanges[prevIndex]);

    // BUG 5 FIX (v1.2.9 — backward rollover into a NEW file landed at its TOP and then skipped the whole file):
    // when navigating BACKWARD, a MODIFIED file lands at its LAST hunk (bottom) via compareEditor.previousChange,
    // so subsequent 'previous' presses step UP through it. But that command is a NO-OP on a genuinely-NEW file's
    // PLAIN editor (no diff hunks to step to), leaving the caret at line 0 (top). The next 'previous' press then
    // sees stepThroughNewFile('up') with cur<=0 (top edge), returns false, and jumps to the file BEFORE it — so
    // the entire new file's content is skipped unseen (only its first screenful was ever visible via backward
    // nav). Fix: for a genuinely-new target (isFullyAddedFile — the SAME shared predicate newFileScrollEditor
    // uses), pin the caret at the file's LAST line (bottom) — mirroring how a modified file lands at its last
    // hunk — so the following 'previous' press's stepThroughNewFile('up') is NOT at the top edge and steps up
    // through the whole file. IMPORTANT: only do the (retried) new-file landing when the TARGET is actually a
    // new file; a modified/deleted target takes the immediate compareEditor.previousChange path with NO delay
    // (the retry loop must never add latency to the common backward-diff rollover).
    // v1.2.15: the retry + bottom-landing logic (and the !staged gate rationale) now lives in the shared
    // landNewFileTargetAtBottom helper so openLastFile can reuse it. If the target was a genuinely-new
    // plain-editor file, the helper landed it at the bottom and we're done — do NOT run compareEditor.previousChange.
    if (await landNewFileTargetAtBottom(fileChanges[prevIndex])) {
        return;
    }
    // Diff (modified/renamed) file, or any non-new-file view: land at the LAST hunk exactly as before so
    // subsequent 'previous' presses step up through the diff. No delay on this common path.
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

// Shared step logic for new-file scroll mode: scroll `editor` `direction` by newFileNavLineJump lines within
// a fully-added file so you can page through it. Returns true if it scrolled a step (caller stops), or false
// if the far edge of the file is already on screen (caller falls through to the next/previous FILE — matching
// the normal end-of-changes behaviour so the review flow keeps going).
//
// v1.2.15 ROOT-CAUSE REWRITE — VIEWPORT-DERIVED, not caret-derived (Ethan 2026-07-10 bug):
//   SYMPTOM: on a new untracked file that looked like it was AT THE TOP, pressing NEXT shot straight past the
//   whole file ("went to the bottom / next file") instead of stepping +5 down.
//   CAUSE: the old logic decided the edge (`cur >= last` / `cur <= 0`) and the step target PURELY from the
//   CARET line (editor.selection.active.line), never from what was actually on screen. But the caret and the
//   viewport routinely DECOUPLE in this flow: backward rollover into a new file (openPreviousFile) PINS the
//   caret at the file's LAST line while the file — if it fits on screen — is rendered from its TOP. So the
//   user SEES the top, but the caret is secretly at the bottom; the next NEXT press read caret>=last, hit the
//   `atEdge` branch, and rolled over to the next file. (Codex independently confirmed the caret math alone can
//   never reach EOF from the top — the "bottom" jump could only come from a caret that was already at the
//   bottom.) Compounding it, the old `revealRange(target, InCenter)` produced NO visible scroll for the first
//   few presses of a tall file: centring a near-top target line clamps to top, so the caret crept down
//   invisibly until it passed the viewport centre, then the view lurched.
//   FIX: derive EVERYTHING from the live viewport (editor.visibleRanges via readViewport) — the exact
//   "recompute-live, viewport-is-the-state" philosophy the tall-hunk stepper (stepTallHunk) already uses, and
//   which the task called out. DOWN advances to the next file ONLY when the file's last line is already
//   visible (bottom >= last); otherwise it scrolls the viewport top down by `step` (AtTop, so it scrolls
//   immediately and visibly). UP mirrors it: advance to the previous file only when the first line is visible
//   (top <= 0); otherwise scroll up by `step`. The caret is pinned to the new top-visible line so it stays
//   COUPLED to the viewport (keeps revert-and-save / any caret-relative command targeting what's on screen).
//   Because edge detection keys off the viewport BOTTOM (unaffected by AtTop's near-EOF scroll clamp), the
//   final down-step can never stick near the bottom — the same clamp that plagued the v1.2.10 tall-hunk bug is
//   sidestepped here: a clamped down-step still makes `bottom` reach `last`, so the NEXT press advances.
//
// v1.2.1 legacy note (superseded in v1.2.22): this used to call showTextDocument to focus the file before
// stepping because an unfocused editor did not draw its caret. That call can return/activate a replacement
// TextEditor object for the same document, however, which defeats the exact-editor identity required by the
// focus-independent reveal waiter below. The active-tab gate already hands us the TextEditor that is actually
// rendering the tab, and editor-scoped revealRange works without keyboard/OS focus, so keep and operate on that
// object. Selection still updates; VS Code draws the caret whenever the editor next receives focus.
const stepThroughNewFile = async (editor: vscode.TextEditor, direction: "down" | "up"): Promise<boolean> => {
    const configured = vscode.workspace.getConfiguration("better-git-vscode").get<number>("newFileNavLineJump", 5);
    // Guard bad user values: 0 / negative / NaN would "step" in place forever — a permanent no-op. Floor
    // fractional values; anything non-usable falls back to the default 5.
    const step = Number.isFinite(configured) && (configured as number) >= 1 ? Math.floor(configured as number) : 5;

    const stepEditor = editor;
    const last = Math.max(0, stepEditor.document.lineCount - 1);
    const vp = readViewport(stepEditor);
    if (!vp) {
        // Editor not laid out yet (visibleRanges empty) — fall back to the pre-v1.2.15 caret-based step so a
        // press is never silently swallowed. Best-effort; the viewport path takes over on the next press once
        // the editor is laid out.
        const cur = stepEditor.selection.active.line;
        const atEdge = direction === "down" ? cur >= last : cur <= 0;
        if (atEdge) {
            debugLog("new-file", `${direction}: no viewport + caret at edge (L${cur + 1}/L${last + 1}) -> advance to ${direction === "down" ? "next" : "previous"} file`);
            return false;
        }
        const target = direction === "down" ? Math.min(cur + step, last) : Math.max(cur - step, 0);
        await revealTopAndPinCursor(stepEditor, target);
        debugLog("new-file", `${direction}: no viewport, caret-fallback step L${cur + 1}->L${target + 1} (step=${step})`);
        return true;
    }

    const { top, bottom, visLines } = vp;
    const caret = stepEditor.selection.active.line;
    if (direction === "down") {
        // Bottom edge reached ONLY when the file's last line is genuinely on screen. Advance to the next file.
        if (bottom >= last) {
            debugLog("new-file", `down: last line L${last + 1} visible (viewport L${top + 1}-L${bottom + 1}) -> advance to next file`);
            return false;
        }
        // Scroll the viewport DOWN by `step` lines through the shared forced-scroll helper. Caret is pinned to
        // the new top so it tracks what's shown; unlike the old direct AtTop call, this cannot no-op merely
        // because the target line was already visible inside the old viewport.
        // The caret is the exact logical-line progression anchor. visibleRanges.top is not: with word wrap,
        // sticky scroll, or other editor context VS Code can report a top a few logical lines away from the
        // line requested with AtTop. Using that reported top made repeated +5 presses drift to +7 and made the
        // reverse path asymmetric. The viewport still owns edge detection (what the user has actually read),
        // while the caret—pinned by every successful step—owns the configured ±N progression.
        const newTop = Math.min(caret + step, last);
        await revealTopAndPinCursor(stepEditor, newTop);
        debugLog("new-file", `down: step caret L${caret + 1}->L${newTop + 1} (viewport L${top + 1}-L${bottom + 1}, last L${last + 1}, vis=${visLines}, step=${step})`);
        return true;
    }
    // UP mirror: top edge reached ONLY when the first line is on screen. Advance to the previous file.
    if (top <= 0) {
        debugLog("new-file", `up: first line visible (viewport L${top + 1}-L${bottom + 1}) -> advance to previous file`);
        return false;
    }
    const newTop = Math.max(caret - step, 0);
    await revealTopAndPinCursor(stepEditor, newTop);
    debugLog("new-file", `up: step caret L${caret + 1}->L${newTop + 1} (viewport L${top + 1}-L${bottom + 1}, last L${last + 1}, vis=${visLines}, step=${step})`);
    return true;
};

// ──────────────────────────────────────────────────────────────────────────────────────────
// TALL-HUNK STAGING (v1.2.6)
//
// WHY this exists (Ethan's exact problem): when reviewing with next/previous-change, a hunk that is
// TALLER than the visible editor is a pain. One press of next-change lands you at the START (top) of the
// hunk, but the rest of it runs off the bottom of the screen. To read the rest he has to take his hands
// off the keyboard, scroll manually, then press next again. He wants to STEP THROUGH a tall hunk in
// stages using the SAME next/previous-change keys: next lands at the top; pressing next AGAIN scrolls
// DOWN by ~a screenful within that same hunk; repeat until the BOTTOM is on screen; the NEXT press then
// advances to the next hunk. previous-change mirrors it (step UP in stages, then advance to the prev hunk).
//
// ── DESIGN CHOICE: STATELESS / VIEWPORT-DERIVED, NOT AN EXPLICIT STATE MACHINE ──
// The spec framed this as a state machine ("track that you're mid-scrolling hunk X in direction D, reset
// when you switch files / reverse / move the cursor"). We deliberately implement it WITHOUT a persisted
// state object, because the viewport + cursor ARE the state and they're always live and exactly what
// Ethan sees on screen. Every press RECOMPUTES from three live facts: (1) the current viewport
// (editor.visibleRanges — real height, adapts to his window size), (2) the cursor line (our logical
// "current change" anchor), and (3) the current file's hunk geometry (parsed fresh from git). This is the
// same "recompute-live, tab-derived, focus-independent" philosophy the rest of this file already uses
// (see visibleEditorForActiveTab / getActiveChange) and it makes ALL the required reset rules fall out
// for free, with NO stale-state bugs to chase:
//   • switch files / editors      -> a different tab means different hunks + a cursor at the new file; the
//                                     old file's viewport is gone, so there's nothing stale to reset.
//   • reverse direction mid-scroll -> "previous while scrolling down" just runs the UP branch against the
//                                     live viewport: it sees the hunk top is still off-screen above and
//                                     steps back UP one screenful. No teleport, because we never stored a
//                                     "we were going down" flag to contradict.
//   • cursor / selection moves elsewhere -> the cursor is no longer inside any tall hunk, so
//                                     hunkContainingLine() returns undefined and we fall straight through
//                                     to today's plain hunk-to-hunk navigation.
//   • reached the end of the hunk  -> handled explicitly below (bottom/top already visible -> advance).
//
// ── CURSOR vs SCROLL ──
// While stepping we move BOTH the viewport (revealRange) AND pin the cursor to the top visible line of the
// new viewport. Keeping the caret inside the hunk (rather than leaving it at the file top) means: (a) other
// commands stay sensible — revert-and-save (git.revertSelectedRanges) reverts the hunk the caret sits in,
// which is exactly the hunk being read; and (b) when we DO advance, VS Code's built-in
// compareEditor.next/previousChange navigates relative to the caret, so from inside the current (single,
// contiguous) hunk it correctly lands on the following / preceding hunk.
//
// ── HOW WE KNOW A HUNK'S EXTENT ──
// VS Code's built-in change navigation only exposes hunk STARTS (it moves the caret to each change), never
// a hunk's END — and there's no stable public API on a diff editor to read its change regions on engine
// ^1.83 (TextEditor.diffInformation is proposed API). So we compute the modified-side hunk ranges ourselves
// by asking the git extension for the file's unified diff and parsing the `@@ ... +newStart,newCount @@`
// headers (see getModifiedSideHunks). A "hunk" here = a maximal run of ADDED ('+') lines on the modified
// side, which is exactly what the built-in navigation treats as one change stop — so our geometry lines up
// with where next/previous-change actually land. Deleted-only regions produce no modified-side lines, are
// never tall, and simply aren't in the list (the caret won't be "inside" one -> we defer to the built-in).
//
// ── COMPOSITION (must not break anything) ──
// This layer is an INTERPOSER: it runs only for side-by-side text diffs (TabInputTextDiff) and only when it
// decides the caret is inside a genuinely-tall hunk whose far edge isn't on screen yet. In every other case
// it returns "not consumed" and the EXISTING navigation runs byte-for-byte as before — so the new-file
// line-scroll (plain-editor added files), modified-file hunk nav, deleted files, cross-file rollover, the
// smart mouse commands (which just executeCommand these same scm-change commands), and the dvorak/qwerty
// key gating are all untouched. Everything is defensive (try/catch, empty-diff -> defer) so a parse failure
// can never turn a keypress into a dead no-op — worst case it degrades to today's plain hunk navigation.

// One contiguous changed region on the modified (new/right) side of a diff, as 0-based inclusive line
// numbers matching the editor's modified-side document. Produced by getModifiedSideHunks.
interface ModifiedHunk {
    start: number; // first changed line (0-based)
    end: number; // last changed line (0-based, inclusive)
}

// Reads the live config for the whole feature in one place so every helper agrees on the numbers. All the
// "auto" defaults resolve against the passed-in visible line count so they adapt to Ethan's actual window
// height (a blind fixed page-jump loses your place; viewport-relative feels right). Bad/absent values fall
// back to sane defaults — never NaN/0 that could freeze stepping in place.
const hunkStagingConfig = (visLines: number) => {
    const cfg = vscode.workspace.getConfiguration("better-git-vscode");
    const enabled = cfg.get<boolean>("hunkStagingEnabled", true);
    // Overlap: lines kept on screen between consecutive steps so reading context carries across (default 4).
    const rawOverlap = cfg.get<number>("hunkStagingOverlap", 4);
    const overlap = Number.isFinite(rawOverlap) && (rawOverlap as number) >= 0 ? Math.floor(rawOverlap as number) : 4;
    // Threshold: minimum hunk height (lines) to ENGAGE staging. 0 (default) = "auto" = the visible viewport
    // height, so staging kicks in exactly when the hunk can't fit on one screen. A positive value overrides.
    const rawThreshold = cfg.get<number>("hunkStagingThreshold", 0);
    const threshold =
        Number.isFinite(rawThreshold) && (rawThreshold as number) > 0 ? Math.floor(rawThreshold as number) : visLines;
    // Step: lines to scroll per press. 0 (default) = "auto" = one viewport MINUS the overlap (so you advance
    // ~a screenful but keep a few lines of context). A positive value overrides with a fixed line count.
    const rawStep = cfg.get<number>("hunkStagingLineStep", 0);
    const step =
        Number.isFinite(rawStep) && (rawStep as number) > 0
            ? Math.max(1, Math.floor(rawStep as number))
            : Math.max(1, visLines - overlap);
    return { enabled, overlap, threshold, step };
};

// Parse the modified-side (new/right) contiguous changed regions of the file currently being reviewed, so
// we know each hunk's full vertical extent (start..end). We get the unified diff straight from the git
// extension and read the `@@ -old +newStart,newCount @@` headers, then within each header's body count the
// modified-side line number as we walk it: ' ' context and '+' added lines each occupy a modified line
// (advance the counter); '-' removed lines exist only on the OLD side (don't advance, don't break a run —
// in a replacement all '-' come before the '+' block, so the '+' lines stay contiguous). Each maximal run
// of '+' lines becomes one ModifiedHunk. Line numbers therefore match the editor's modified document:
//   • unstaged side  -> modified doc is the on-disk working file; the working-vs-INDEX diff's +lines are
//                       working lines. This is the SAME diff git.openChange DISPLAYS for the unstaged side.
//   • staged  side   -> modified doc is the git: index blob; diffIndexWithHEAD's +lines are index lines.
//
// BUG 6 FIX (v1.2.9): the unstaged side previously parsed repo.diffWithHEAD (working-tree-vs-HEAD), but the
// editor shows working-tree-vs-INDEX. For a PARTIALLY-staged file those diffs DIFFER: regions already staged
// appear as '+' hunks in HEAD-vs-working but are NOT change regions in the shown index-vs-working editor. The
// old comment claimed "tall-hunk detection stays correct" — WRONG: the +line NUMBERS share the working-doc
// coordinate space, but the SET and EXTENT of hunks differ, and stepping depends on exactly those. So the
// caret could sit inside a "phantom" tall hunk over content that looks unchanged in the shown diff, or two
// adjacent staged+unstaged edits could merge into one over-long run, over-estimating height. Fully-unstaged
// files (index==HEAD) were unaffected; only partially-staged files broke. Fix: parse the SAME working-vs-index
// diff the editor displays. The vscode.git API has no per-PATH working-vs-index string method (diff(cached=false)
// returns the WHOLE-repo `git diff`), so we fetch the full diff once and extract just this file's section
// (extractFileDiffSection) before feeding it to the unchanged parser — routing only the SOURCE, not forking
// the parser. Any failure (git API not ready, method missing, unreadable diff, file not in the diff) returns
// [] so callers defer to plain navigation.

// Extract the single-file section for `fileUri` out of a multi-file unified diff (as produced by git diff of
// the whole repo). A unified diff is a concatenation of per-file sections, each starting with a
// `diff --git a/<rel> b/<rel>` header. We locate the section whose modified-side header line (`+++ b/<rel>`)
// matches this file's repo-relative path and return just that section's text; the existing @@-parser then
// sees exactly one file's hunks. Returns "" when the file isn't present (e.g. it's fully staged so it has no
// working-vs-index changes), which makes getModifiedSideHunks return [] and defer to plain navigation.
const extractFileDiffSection = (fullDiff: string, fileUri: vscode.Uri, repo: any): string => {
    if (!fullDiff) {
        return "";
    }
    // Repo-relative, forward-slashed, lowercased path — how it appears (case-insensitively) after `+++ b/`.
    const rootPath: string | undefined = repo?.rootUri?.fsPath;
    let rel = fileUri.fsPath;
    if (rootPath && rel.toLowerCase().startsWith(rootPath.toLowerCase())) {
        rel = rel.slice(rootPath.length);
    }
    rel = rel.replace(/^[\/\\]+/, "").replace(/\\/g, "/").toLowerCase();
    const lines = fullDiff.split("\n");
    // Walk sections: a new section begins at each "diff --git" line. Collect the current section; when we hit
    // the next header (or end), decide whether the section we just closed is the one we want (its `+++ b/<rel>`
    // — or, for a deletion, `--- a/<rel>` — matches). Return the first matching section.
    let current: string[] = [];
    let matched: string[] | undefined;
    const targetMarkers = [`+++ b/${rel}`, `--- a/${rel}`];
    const closeSection = () => {
        if (current.length === 0) {
            return;
        }
        const isMatch = current.some((l) => {
            const low = l.toLowerCase();
            return targetMarkers.some((m) => low === m);
        });
        if (isMatch && !matched) {
            matched = current;
        }
        current = [];
    };
    for (const line of lines) {
        if (line.startsWith("diff --git ")) {
            closeSection(); // finish the previous section before starting a new one
            current = [line];
            continue;
        }
        if (current.length > 0) {
            current.push(line);
        }
    }
    closeSection(); // flush the final section
    return matched ? matched.join("\n") : "";
};

const getModifiedSideHunks = async (fileUri: vscode.Uri, staged: boolean): Promise<ModifiedHunk[]> => {
    try {
        const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
        const repo = git?.getRepository(fileUri);
        if (!repo) {
            return []; // no owning repo (or git not ready) -> defer to built-in navigation
        }
        // Ask git for THIS file's unified diff on the correct side (BUG 6 FIX — see the big comment above):
        //   • staged   -> diffIndexWithHEAD(path): index-vs-HEAD, matching the shown staged diff. Per-path.
        //   • unstaged -> working-tree-vs-INDEX, matching the shown unstaged diff. The API has no per-path
        //                 form (diff(cached=false) is whole-repo), so we get the full diff and extract this
        //                 file's section — parsing HEAD-vs-working here would mis-detect partially-staged files.
        let diffText: string;
        if (staged) {
            diffText = await repo.diffIndexWithHEAD(fileUri.fsPath); // staged diff (index vs HEAD)
        } else {
            const fullWorkingVsIndex: string = await repo.diff(false); // `git diff` — working tree vs index, whole repo
            diffText = extractFileDiffSection(fullWorkingVsIndex, fileUri, repo); // just this file's section
        }
        if (!diffText) {
            return [];
        }
        const hunks: ModifiedHunk[] = [];
        const lines = diffText.split("\n");
        // Matches a unified-diff hunk header and captures the modified-side (+) start line and count.
        const headerRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
        let modLine = 0; // 1-based modified-side line number as we walk the current hunk body
        let inHunk = false;
        let runStart = -1; // start of the current '+' run (1-based), or -1 when not in a run
        let runEnd = -1; // last line of the current '+' run (1-based)
        const closeRun = () => {
            if (runStart !== -1) {
                hunks.push({ start: runStart - 1, end: runEnd - 1 }); // convert to 0-based inclusive
                runStart = -1;
                runEnd = -1;
            }
        };
        for (const line of lines) {
            const header = headerRe.exec(line);
            if (header) {
                closeRun(); // a new header ends any run from the previous hunk
                modLine = parseInt(header[1], 10); // +newStart
                inHunk = true;
                continue;
            }
            if (!inHunk) {
                continue; // skip the file header lines (diff --git, index, ---, +++) before the first @@
            }
            const c = line[0];
            if (c === "+") {
                if (runStart === -1) {
                    runStart = modLine; // begin a new run of added lines
                }
                runEnd = modLine;
                modLine++;
            } else if (c === " ") {
                closeRun(); // context line ends a run and occupies a modified-side line
                modLine++;
            } else if (c === "-") {
                // Removed line: exists only on the OLD side. Don't advance the modified counter, and don't
                // break the run — the following '+' lines (if any) remain contiguous in modified numbering.
            } else {
                // "\ No newline at end of file" markers, blank trailing token from the final split, etc.
                closeRun();
            }
        }
        closeRun(); // flush the last run at end of diff
        return hunks;
    } catch {
        return []; // git API shape changed / diff failed -> defer to plain navigation
    }
};

// Find the hunk the caret is currently sitting in (our "logical current change"). Uses CONTAINMENT with a
// tiny tolerance: the built-in change navigation can land the caret a line off from our parsed hunk start,
// so we treat [start-tol, end+tol] as "inside". Returns undefined when the caret isn't inside any hunk
// (e.g. resting in unchanged code between hunks) -> caller defers to plain hunk-to-hunk navigation.
const hunkContainingLine = (hunks: ModifiedHunk[], line: number, tol = 1): ModifiedHunk | undefined => {
    return hunks.find((h) => line >= h.start - tol && line <= h.end + tol);
};

// Bundle of everything the stepping logic needs for the file currently under review, or undefined when
// tall-hunk staging doesn't apply (feature off, not a side-by-side diff tab, no resolvable editor/file, or
// no parsed hunks). Computing this once per press means we parse the diff a single time and reuse it for
// both the step decision and the on-landing reveal.
interface HunkStageContext {
    editor: vscode.TextEditor; // the visible editor rendering the modified side (the thing we scroll)
    hunks: ModifiedHunk[]; // modified-side change regions for this file
}

const getHunkStageContext = async (): Promise<HunkStageContext | undefined> => {
    // A quick viewport-independent gate read first (visLines only affects the numeric knobs, not enablement).
    if (!vscode.workspace.getConfiguration("better-git-vscode").get<boolean>("hunkStagingEnabled", true)) {
        return undefined;
    }
    // ONLY side-by-side text diffs have hunk geometry to step through. Plain-editor tabs (new files,
    // deleted-file HEAD views) are handled by other code paths and must never reach here.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!(tab?.input instanceof vscode.TabInputTextDiff)) {
        return undefined;
    }
    const editor = visibleEditorForActiveTab(); // the modified/right side's actual TextEditor (focus-independent)
    if (!editor) {
        return undefined;
    }
    const fileUri = currentReviewFileUri(); // on-disk file: uri (resolves a staged git: side back to the path)
    if (!fileUri) {
        return undefined;
    }
    // Which side is showing? getActiveChange reports staged===true when the modified side is the git: index
    // blob. That selects diffIndexWithHEAD vs diffWithHEAD so the parsed line numbers match the shown doc.
    const active = await getActiveChange();
    const staged = active?.staged === true;
    const hunks = await getModifiedSideHunks(fileUri, staged);
    if (hunks.length === 0) {
        return undefined; // nothing parseable -> defer to plain navigation
    }
    return { editor, hunks };
};

// Reads the current viewport of an editor as {top, bottom, visLines}. Uses the FIRST visible range's start
// and the LAST visible range's end so folded regions in between don't confuse the height. Returns undefined
// if the editor isn't laid out yet (no visible ranges) -> caller defers.
const readViewport = (editor: vscode.TextEditor): { top: number; bottom: number; visLines: number } | undefined => {
    const ranges = editor.visibleRanges;
    if (!ranges || ranges.length === 0) {
        return undefined;
    }
    const top = ranges[0].start.line;
    const bottom = ranges[ranges.length - 1].end.line;
    return { top, bottom, visLines: Math.max(1, bottom - top + 1) };
};

// Wait briefly for THIS exact TextEditor object to publish the requested top line. revealRange is a void API:
// the renderer applies it asynchronously, so resolving a navigation command immediately lets a rapid second
// keypress read the OLD visibleRanges and repeat the same step. Matching only URI + viewColumn is not sufficient:
// VS Code can replace an editor widget with another editor for the same URI/column, and a delayed visible-range
// event from that replacement must not settle an operation issued to `editor`.
const waitForViewportTop = async (editor: vscode.TextEditor, expectedTop: number): Promise<boolean> => {
    const currentViewport = readViewport(editor);
    if (currentViewport?.top === expectedTop) {
        return true;
    }
    return new Promise<boolean>((resolve) => {
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let subscription: vscode.Disposable | undefined;
        const finish = (reachedExpectedTop: boolean) => {
            if (finished) {
                return;
            }
            finished = true;
            subscription?.dispose();
            if (timer) {
                clearTimeout(timer);
            }
            resolve(reachedExpectedTop);
        };
        subscription = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (event.textEditor !== editor) {
                return;
            }
            const movedViewport = readViewport(event.textEditor);
            if (movedViewport?.top === expectedTop) {
                finish(true);
            }
        });
        timer = setTimeout(() => finish(readViewport(editor)?.top === expectedTop), 120);
    });
};

// Issue one editor-scoped AtTop reveal and wait for the exact viewport it requested. Unlike the global
// `editorScroll` command this API is targeted at the TextEditor passed by the caller, so it keeps working when
// focus is in Source Control, another split, or an entirely different VS Code window.
const revealLineAtTop = async (editor: vscode.TextEditor, line: number): Promise<boolean> => {
    const viewportSettled = waitForViewportTop(editor, line);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    return viewportSettled;
};

// Pick an anchor far enough outside `viewport` that VS Code cannot dismiss it as edge/render slack, but still
// far enough from EOF that AtTop can place it exactly. The first line immediately after visibleRanges is not a
// reliable forcing anchor: the renderer may already regard that line as effectively visible and no-op the reveal.
// A half-viewport jump is visually smaller than going to a document edge while decisively leaving the old view.
const forcingAnchorForViewport = (
    viewport: { top: number; bottom: number; visLines: number },
    last: number,
): number | undefined => {
    const forcingDistance = Math.max(1, Math.ceil(viewport.visLines / 2));
    // Leave at least `visLines` lines after a downward anchor. That avoids the normal EOF clamp that would make
    // the achieved top differ from the exact anchor our waiter requires.
    const greatestExactlyPlaceableTop = Math.max(0, last - viewport.visLines);
    const below = Math.min(greatestExactlyPlaceableTop, viewport.bottom + forcingDistance);
    if (below > viewport.bottom) {
        return below;
    }
    const above = Math.max(0, viewport.top - forcingDistance);
    return above < viewport.top ? above : undefined;
};

// Scroll `editor` so `topLine` is the top visible line, and pin the caret there (kept inside the hunk so
// revert-and-save + the built-in advance both target the right change — see the CURSOR vs SCROLL note).
//
// v1.2.18 ROOT CAUSE — `revealRange(topLine, AtTop)` alone can be ignored by the workbench when `topLine`
// is ALREADY visible. Every downward step deliberately targets `viewport.top + step`, which is normally still
// inside the current viewport. The first press moved the caret from L1 to L6 but left the viewport at L1; every
// later press recomputed the same L6 target and became a permanent no-op. Up appeared healthy because its target
// is ABOVE the viewport and therefore necessarily forces a reveal.
//
// v1.2.22 replaces the attempted workaround (`commands.executeCommand("editorScroll", ...)`) entirely. That
// command scrolls whichever editor widget currently owns keyboard focus; its object argument cannot target the
// TextEditor received here. It therefore silently no-ops when review runs from Source Control, another split, or
// an unfocused/background VS Code window. Its `{to, by, value, revealCursor}` argument is also an untyped internal
// command contract, while TextEditor.revealRange is the public editor-scoped API supported by our VS Code engine.
//
// To preserve the v1.2.18 already-visible fix while using the public API, first reveal an OFF-SCREEN forcing
// anchor whenever the requested top is currently visible. AtTop cannot ignore that first reveal because the anchor
// is outside the viewport. As soon as that anchor viewport is observed, reveal the real target AtTop; now the target
// is off-screen too, so the second reveal is likewise forced. Wrapped lines and sticky context can make the final
// exact logical top unattainable; that is not retried because a second anchor round-trip caused the visible glitch
// in v1.2.22. Progress is instead guaranteed by pinning the exact requested caret line below.
const revealTopAndPinCursor = async (editor: vscode.TextEditor, topLine: number): Promise<void> => {
    const last = Math.max(0, editor.document.lineCount - 1);
    const clampedTop = Math.max(0, Math.min(topLine, last));
    const viewportBefore = readViewport(editor);
    if (!viewportBefore || clampedTop === viewportBefore.top) {
        // No layout yet: retain the direct API fallback. Equal-top needs only the caret pin (no scroll wait).
        const pos = new vscode.Position(clampedTop, 0);
        editor.selection = new vscode.Selection(pos, pos);
        if (!viewportBefore) {
            editor.revealRange(new vscode.Range(clampedTop, 0, clampedTop, 0), vscode.TextEditorRevealType.AtTop);
        }
        return;
    }

    const targetIsVisible = clampedTop >= viewportBefore.top && clampedTop <= viewportBefore.bottom;
    let revealTopOffset = 0;
    if (targetIsVisible) {
        // Prefer a half-viewport-distant line below; above covers near-EOF cases. If neither exists, every
        // document line is already visible and VS Code has no scrollable layout to move.
        const forcingAnchor = forcingAnchorForViewport(viewportBefore, last);
        if (forcingAnchor === undefined) {
            const pos = new vscode.Position(clampedTop, 0);
            editor.selection = new vscode.Selection(pos, pos);
            return;
        }

        await revealLineAtTop(editor, forcingAnchor);
        const viewportAfterAnchor = readViewport(editor);
        if (viewportAfterAnchor) {
            // Calibrate ordinary sticky/context padding from the forcing reveal. This preserves exact viewport
            // placement in normal layouts; the caret remains authoritative when wrapped geometry varies by line.
            revealTopOffset = forcingAnchor - viewportAfterAnchor.top;
        }
    }

    const targetRevealLine = Math.max(0, Math.min(clampedTop + revealTopOffset, last));
    let reachedRequestedTop = targetRevealLine === clampedTop
        ? await revealLineAtTop(editor, clampedTop)
        : await (async () => {
        const viewportSettled = waitForViewportTop(editor, clampedTop);
        editor.revealRange(
            new vscode.Range(targetRevealLine, 0, targetRevealLine, 0),
            vscode.TextEditorRevealType.AtTop,
        );
        return viewportSettled;
    })();

    // A dropped reveal in a non-wrapped editor still gets one bounded retry; exact top placement is achievable
    // there and is required by tall-hunk cursor/view coupling. Wrapped editors deliberately skip this retry:
    // visibleRanges.top can be an unattainable logical line when one source line occupies several visual rows,
    // and v1.2.22's retry then produced the extra back-and-forth flicker Ethan reported.
    const wordWrap = vscode.workspace.getConfiguration("editor", editor.document.uri).get<string>("wordWrap", "off");
    if (!reachedRequestedTop && wordWrap === "off") {
        const viewportAfterFirstReveal = readViewport(editor);
        if (viewportAfterFirstReveal && viewportAfterFirstReveal.top !== clampedTop) {
            const retryAnchor = forcingAnchorForViewport(viewportAfterFirstReveal, last);
            if (retryAnchor !== undefined) {
                await revealLineAtTop(editor, retryAnchor);
                const viewportAfterRetryAnchor = readViewport(editor);
                const retryOffset = viewportAfterRetryAnchor ? retryAnchor - viewportAfterRetryAnchor.top : 0;
                const retryRevealLine = Math.max(0, Math.min(clampedTop + retryOffset, last));
                const viewportSettled = waitForViewportTop(editor, clampedTop);
                editor.revealRange(
                    new vscode.Range(retryRevealLine, 0, retryRevealLine, 0),
                    vscode.TextEditorRevealType.AtTop,
                );
                reachedRequestedTop = await viewportSettled;
            }
        }
    }

    // Pin only after the renderer has moved. The cursor is the exact configured logical-line progression anchor;
    // substituting visibleRanges.top here is what made wrapped/sticky editors drift away from ±5 per press.
    const pos = new vscode.Position(clampedTop, 0);
    editor.selection = new vscode.Selection(pos, pos);
};

// Scroll `editor` so `bottomLine` is brought into view at the BOTTOM of the viewport, and pin the caret THERE.
//
// WHY this is the key to the v1.2.10 stuck-near-the-bottom fix: `revealRange(..., AtTop)` CANNOT place a line
// near end-of-file at the TOP of the viewport — VS Code clamps the scroll (there aren't a viewport's worth of
// lines below it to fill the screen). So the final down-step of a tall hunk that ENDS near EOF asked to put an
// unreachable line at the top, the viewport silently didn't move, yet `remainingBelow` (computed from the
// caret/geometry) still said "not at the bottom" → the press became a no-op and repeated forever, never
// revealing the last few changed lines and never advancing (the exact Ln-202 stuck report on the 240-line
// hunk). Revealing a line at the BOTTOM (RevealType.Default scrolls DOWN to bring an off-screen-below line
// into view) is NEVER EOF-clamped — the line exists, so it always becomes visible. That guarantees the hunk's
// tail lines are shown. We pin the caret to `bottomLine` (the hunk's last line): on the NEXT press stepTallHunk
// sees caret >= hunk.end and definitively advances — no dependence on exact viewport-bottom render slack.
const revealBottomAndPinCursor = (editor: vscode.TextEditor, bottomLine: number): void => {
    const clamped = Math.max(0, Math.min(bottomLine, Math.max(0, editor.document.lineCount - 1)));
    const pos = new vscode.Position(clamped, 0);
    editor.selection = new vscode.Selection(pos, pos); // caret parked on the hunk's last line
    // Default reveal brings the range into view with minimal scroll; for a line below the viewport that lands
    // it at the bottom edge. This direction is unclamped (unlike AtTop near EOF), so the tail always shows.
    editor.revealRange(new vscode.Range(clamped, 0, clamped, 0), vscode.TextEditorRevealType.Default);
};

// THE INTERPOSER. Given the per-press context and which key was pressed, decide whether this press should
// be consumed as an IN-HUNK SCROLL STEP (return true) or fall through to plain hunk-to-hunk navigation
// (return false). Fully live: reads the viewport + caret fresh, so reversing direction / moving the caret /
// switching files all "just work" (see the big design note above).
const stepTallHunk = async (ctx: HunkStageContext, direction: "down" | "up"): Promise<boolean> => {
    const vp = readViewport(ctx.editor);
    if (!vp) {
        debugLog("tall-hunk", `${direction}: no viewport (editor not laid out) -> defer to plain nav`);
        return false; // editor not laid out -> let built-in handle it
    }
    const { top, bottom, visLines } = vp;
    const caret = ctx.editor.selection.active.line;
    const hunk = hunkContainingLine(ctx.hunks, caret);
    if (!hunk) {
        debugLog(
            "tall-hunk",
            `${direction}: caret L${caret + 1} not inside any hunk (top=L${top + 1} bottom=L${bottom + 1} vis=${visLines}) -> defer to plain nav (advance)`,
        );
        return false; // caret isn't inside a hunk (between changes / moved away) -> plain navigation
    }
    const { threshold, step } = hunkStagingConfig(visLines); // overlap only feeds `step` now (BUG 8 removed TINY_TAIL)
    const span = hunk.end - hunk.start + 1;
    // Shared context line for EVERY decision below — 1-based line numbers so it matches the editor's gutter,
    // which is what Ethan reads off the screenshots. hunk shown as its 1-based start..end.
    const base =
        `${direction}: hunk L${hunk.start + 1}-L${hunk.end + 1} (span=${span}) | ` +
        `viewport top=L${top + 1} bottom=L${bottom + 1} vis=${visLines} | caret=L${caret + 1} | step=${step} threshold=${threshold}`;
    if (span <= threshold) {
        debugLog("tall-hunk", `${base} | DECISION: hunk fits on screen (span<=threshold) -> defer to plain nav`);
        return false; // hunk fits on one screen (or under the override threshold) -> behave EXACTLY as today
    }
    // BUG 8 FIX (v1.2.9): advance only when the far edge is FULLY on screen (remaining <= 0), not when a
    // "tiny tail" of up to overlap(=4) CHANGED lines is still off screen. (See the long history note that
    // used to be here; kept short now.) The v1.2.10 fix below is layered on top of that guard.
    //
    // ── BUG 14 FIX (v1.2.10) — the "stuck near the bottom of a tall hunk" dead-end ──
    // Symptom (reproduced on the Mini, v1.2.9): stepping DOWN a 240-line hunk stuck at ~Ln 202 showing the
    // final screenful minus the last few lines — repeated next-change did nothing, the tail (236-240) never
    // showed, and it never advanced to the next file. Root cause: the final down-step computed a target `top`
    // of `hunk.end - visLines + 1` and revealed it with `AtTop`, but VS Code CANNOT put a near-EOF line at the
    // TOP of the viewport (it clamps the scroll — there aren't a viewport's worth of lines below it). So the
    // viewport silently didn't move, while `remainingBelow = hunk.end - bottom` stayed > 0 → the press became
    // an infinite no-op. Two-part fix:
    //   (1) When the caret is already parked AT (or past) the hunk's last line, we've shown the tail on a
    //       previous press (the final step pins the caret to hunk.end). Advance now — a definitive
    //       "reached the bottom" signal that can't be fooled by a few lines of EOF render slack.
    //   (2) The FINAL down-step (whose normal target would reach/exceed the last-line-at-bottom position)
    //       reveals the hunk's END at the BOTTOM (RevealType.Default, which scrolls DOWN and is NEVER
    //       EOF-clamped) instead of an unreachable line at the top — guaranteeing the tail is seen — and pins
    //       the caret to hunk.end so signal (1) fires on the next press. UP is unaffected: AtTop of a line
    //       near the TOP of the document (hunk.start) is always reachable, so it never clamps.
    if (direction === "down") {
        // Signal (1): caret already parked at/after the hunk end from a prior final step -> definitively advance.
        if (caret >= hunk.end) {
            debugLog("tall-hunk", `${base} | DECISION: caret at hunk end (tail already shown) -> advance to next change/file`);
            return false;
        }
        const remainingBelow = hunk.end - bottom; // lines of the hunk still below the viewport
        if (remainingBelow <= 0) {
            debugLog("tall-hunk", `${base} | remainingBelow=${remainingBelow} | DECISION: hunk bottom on screen -> advance to next change/file`);
            return false; // bottom of the hunk is fully on screen -> advance to next hunk
        }
        // The top position where the hunk's LAST line sits at the bottom of the viewport. Never below hunk.start.
        const maxTop = Math.max(hunk.start, hunk.end - visLines + 1);
        // FINAL STEP: a normal screenful-minus-overlap step would reach or pass maxTop, i.e. this press should
        // land on the hunk's tail. Reveal the END at the bottom (unclamped) rather than AtTop-an-unreachable-line.
        if (top + step >= maxTop) {
            revealBottomAndPinCursor(ctx.editor, hunk.end); // shows [maxTop..hunk.end]; caret parked at hunk.end
            debugLog(
                "tall-hunk",
                `${base} | remainingBelow=${remainingBelow} maxTop=L${maxTop + 1} | DECISION: FINAL step -> reveal hunk end L${hunk.end + 1} at bottom, caret parked at end (next press advances)`,
            );
            return true;
        }
        // NORMAL step: scroll down ~one screenful (minus overlap), never past maxTop. The shared helper forces
        // an actual viewport move even when newTop is still visible at the bottom of the current screen.
        let newTop = Math.min(top + step, maxTop);
        if (newTop <= top) {
            newTop = top + step; // guarantee forward progress even in odd geometry
        }
        await revealTopAndPinCursor(ctx.editor, newTop);
        debugLog("tall-hunk", `${base} | remainingBelow=${remainingBelow} maxTop=L${maxTop + 1} | DECISION: step DOWN, newTop=L${newTop + 1}`);
        return true;
    } else {
        // ── UP direction — the EXACT MIRROR of the down branch above (BUG 15 FIX, v1.2.12) ──
        // Symmetry contract (must not drift again): down guards the BOTTOM edge with a caret signal
        // (caret >= hunk.end) + a final step that reveals hunk.end at the BOTTOM; up guards the TOP edge with
        // the mirrored caret signal (caret <= hunk.start) + a final step that reveals hunk.start at the TOP.
        // Same three-stage shape in both branches: (1) caret-at-far-edge -> advance; (2) far edge already fully
        // on screen -> advance; (3) final step reveals the far edge and parks the caret there; else normal step.
        //
        // BUG 15 (v1.2.11, Ethan report — "stepping UP a tall hunk, at the TOP it loops back to the BOTTOM
        // instead of going to the previous change"): the OLD up branch relied SOLELY on the viewport-derived
        // `remainingAbove <= 0` to decide "top reached -> advance", with NO caret-derived signal — the exact
        // asymmetry the v1.2.10 down fix removed for the bottom edge. When render slack / the built-in nav left
        // `top` a hair off hunk.start, `remainingAbove` never cleanly hit <= 0, so the press re-entered the step
        // path (its `newTop = top - step` fallback could even scroll ABOVE the hunk), and when the built-in
        // advance DID fire it could re-land inside the SAME merged hunk — then revealHunkOnLanding re-showed the
        // hunk's BOTTOM. Net effect: an infinite within-hunk loop that never reached the previous change.
        // Fix: mirror the bottom edge exactly.
        //   (1) Caret already parked AT (or above) the hunk's first line -> the top was shown on a prior press
        //       (the final step pins the caret to hunk.start). Advance now — a definitive "reached the top"
        //       signal that can't be fooled by a line or two of viewport render slack (mirror of caret>=hunk.end).
        //   (2) The FINAL up-step reveals hunk.start at the TOP (AtTop of a line near the TOP of the document is
        //       ALWAYS reachable — never clamps, unlike AtTop near EOF going down) and pins the caret to
        //       hunk.start so signal (1) fires on the next press. Normal steps scroll up ~one screenful.
        // Signal (1): caret already parked at/before the hunk start from a prior final step -> definitively advance.
        if (caret <= hunk.start) {
            debugLog("tall-hunk", `${base} | DECISION: caret at hunk start (top already shown) -> advance to previous change/file`);
            return false;
        }
        const remainingAbove = top - hunk.start; // lines of the hunk still above the viewport
        if (remainingAbove <= 0) {
            debugLog("tall-hunk", `${base} | remainingAbove=${remainingAbove} | DECISION: hunk top on screen -> advance to previous change/file`);
            return false; // top of the hunk is fully on screen -> advance to previous hunk
        }
        // The top position where the hunk's FIRST line sits at the top of the viewport. Mirror of `maxTop`
        // (which put the LAST line at the viewport bottom); here the far edge going up is simply hunk.start.
        const minTop = hunk.start;
        // FINAL STEP: a normal screenful-minus-overlap step would reach or pass minTop, i.e. this press should
        // land on the hunk's head. Reveal the START at the top (AtTop near doc-top never clamps) and park caret.
        if (top - step <= minTop) {
            await revealTopAndPinCursor(ctx.editor, hunk.start); // shows [hunk.start..]; caret parked at hunk.start
            debugLog(
                "tall-hunk",
                `${base} | remainingAbove=${remainingAbove} minTop=L${minTop + 1} | DECISION: FINAL step -> reveal hunk start L${hunk.start + 1} at top, caret parked at start (next press advances)`,
            );
            return true;
        }
        // NORMAL step: scroll up ~one screenful (minus overlap), never past minTop. Mirror of the down clamp.
        let newTop = Math.max(top - step, minTop);
        if (newTop >= top) {
            newTop = top - step; // guarantee upward progress even in odd geometry
        }
        await revealTopAndPinCursor(ctx.editor, newTop);
        debugLog("tall-hunk", `${base} | remainingAbove=${remainingAbove} minTop=L${minTop + 1} | DECISION: step UP, newTop=L${newTop + 1}`);
        return true;
    }
};

// After the built-in navigation ADVANCES to a new hunk within the same file, reposition the viewport so a
// tall hunk is presented for stage-stepping: going DOWN we land at its TOP (a full screenful from the
// start, so the NEXT press steps down); going UP we land showing its BOTTOM portion (so the next press
// steps UP toward the top). Short hunks are left exactly where the built-in put them (don't disturb today's
// feel). Best-effort: no context / no matching hunk -> leave the built-in's own reveal untouched.
const revealHunkOnLanding = async (
    ctx: HunkStageContext,
    caretLine: number,
    direction: "down" | "up",
    avoidHunk?: ModifiedHunk, // the hunk we were stepping in BEFORE the built-in advance (loop guard)
): Promise<void> => {
    const vp = readViewport(ctx.editor);
    if (!vp) {
        return;
    }
    const { visLines } = vp;
    const hunk = hunkContainingLine(ctx.hunks, caretLine);
    if (!hunk) {
        return;
    }
    // ANTI-LOOP GUARD (BUG 15, v1.2.12): if the built-in advance re-landed the caret inside the SAME hunk we
    // were just stepping through (can happen when our merged "+ run" hunk spans multiple VS Code change stops),
    // re-revealing it would bounce the viewport back to that hunk's far edge — the exact "loops back to the
    // bottom" symptom, and its downward twin. Leave the viewport where the built-in put it instead of looping.
    // Identity compare is valid: both come from the same once-parsed ctx.hunks array.
    if (avoidHunk && hunk === avoidHunk) {
        debugLog(
            "tall-hunk",
            `landing(${direction}): built-in advance re-landed inside the SAME hunk L${hunk.start + 1}-L${hunk.end + 1} -> loop guard, leaving viewport as-is`,
        );
        return;
    }
    const { threshold } = hunkStagingConfig(visLines);
    if (hunk.end - hunk.start + 1 <= threshold) {
        return; // short hunk -> the built-in's reveal is fine, don't reposition
    }
    if (direction === "down") {
        await revealTopAndPinCursor(ctx.editor, hunk.start); // land at the top of the tall hunk
        debugLog("tall-hunk", `landing(down): advanced to new tall hunk L${hunk.start + 1}-L${hunk.end + 1}, landed at its top`);
    } else {
        // Land showing the bottom portion so subsequent 'previous' presses step UP through the hunk.
        await revealTopAndPinCursor(ctx.editor, Math.max(hunk.start, hunk.end - visLines + 1));
        debugLog("tall-hunk", `landing(up): advanced to new tall hunk L${hunk.start + 1}-L${hunk.end + 1}, landed showing its bottom`);
    }
};

// Serialize every change-navigation press across keyboard and smart-mouse entry points. The scroll renderer and
// git.openChange both settle asynchronously; without one shared queue, key-repeat can start a second navigation
// against the first press's old viewport/editor and either lose a step or touch a just-disposed TextEditor.
let changeNavigationTail: Promise<void> = Promise.resolve();
const serializeChangeNavigation = (operation: () => Promise<void>): Promise<void> => {
    const run = changeNavigationTail.then(operation, operation);
    // Keep the tail fulfilled even if one best-effort navigation call fails, so later keypresses are never
    // permanently blocked behind a rejected promise. The caller still receives `run` and can observe its error.
    changeNavigationTail = run.catch(() => undefined);
    return run;
};

const goToNextDiffOnce = async () => {
    var activeEditor = vscode.window.activeTextEditor;
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath — avoids the clipboard
    // save/blank/restore hack in the hot path when focus is in the SCM panel. activeEditor is still kept for
    // the navEditor fallback below.
    if (!(await activeNavFilePath())) {
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

    // TALL-HUNK STAGING (v1.2.6): if the caret is inside a hunk taller than the viewport and its BOTTOM
    // isn't on screen yet, consume this press as a downward scroll step (read the next screenful of the
    // same hunk) instead of jumping to the next hunk. When it returns false (short hunk, bottom already
    // visible, caret not in a hunk, or feature off) we fall through to the unchanged navigation below, so
    // nothing else is disturbed. See the big design note above getModifiedSideHunks.
    const stageCtx = await getHunkStageContext();
    if (stageCtx && (await stepTallHunk(stageCtx, "down"))) {
        return; // press was a within-hunk scroll step
    }

    // Hunk navigation. Read the cursor from the TAB's own editor (falling back to the focused editor) so
    // the moved/didn't-move detection below works even when keyboard focus is in the SCM panel —
    // activeTextEditor alone could be a stale different-file editor there, which made the before/after
    // compare meaningless (always "didn't move" -> premature file jumps, or missed jumps).
    const navEditor = visibleEditorForActiveTab() ?? activeEditor;
    const lineBefore = navEditor?.selection.active.line;
    // Loop guard input: which hunk (if any) the caret sat in BEFORE the advance, so revealHunkOnLanding can
    // detect a built-in advance that re-landed inside the same hunk and refuse to re-reveal it (see BUG 15).
    const hunkBefore =
        stageCtx && lineBefore !== undefined ? hunkContainingLine(stageCtx.hunks, lineBefore) : undefined;
    await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");
    const lineAfter = navEditor?.selection.active.line; // TextEditor.selection is live — same object, post-command state

    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter > lineBefore)) {
        // We've run out of changes in the current file. Jump straight to the next changed file —
        // NO confirmation prompt, ever. The whole point of this tool is keyboard-fast review; a
        // "Jump to next file: ...?" modal would defeat that. (The old promptBeforeNextFile setting +
        // its modal confirmation path were removed entirely — see CHANGELOG v1.0.2.)
        debugLog("nav", `next: no forward change in file (before=L${(lineBefore ?? -1) + 1} after=L${(lineAfter ?? -1) + 1}) -> openNextFile()`);
        await openNextFile();
        return;
    }

    // We advanced to a new hunk WITHIN this file. If it's a tall hunk, land at its TOP so the first
    // screenful shows it from the start and the next press steps down through it (staging). Short hunks are
    // left exactly where the built-in reveal put them. stageCtx.hunks is still valid (same file).
    if (stageCtx && lineAfter !== undefined) {
        await revealHunkOnLanding(stageCtx, lineAfter, "down", hunkBefore);
    }
};

const goToPreviousDiffOnce = async () => {
    var activeEditor = vscode.window.activeTextEditor;
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath (see goToNextDiff).
    if (!(await activeNavFilePath())) {
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

    // TALL-HUNK STAGING (v1.2.6), mirror of goToNextDiff: if the caret is inside a hunk taller than the
    // viewport and its TOP isn't on screen yet, consume this press as an UPWARD scroll step (read the
    // previous screenful of the same hunk) instead of jumping to the previous hunk. Returns false -> fall
    // through to the unchanged navigation below.
    const stageCtx = await getHunkStageContext();
    if (stageCtx && (await stepTallHunk(stageCtx, "up"))) {
        return; // press was a within-hunk upward scroll step
    }

    // Hunk navigation — tab-derived editor for the before/after compare, same rationale as goToNextDiff.
    const navEditor = visibleEditorForActiveTab() ?? activeEditor;
    const lineBefore = navEditor?.selection.active.line;
    // Loop guard input (mirror of goToNextDiff): the hunk the caret sat in before the built-in advance, so we
    // never re-reveal the same hunk's bottom after advancing up — the exact BUG 15 "loops back to bottom" fix.
    const hunkBefore =
        stageCtx && lineBefore !== undefined ? hunkContainingLine(stageCtx.hunks, lineBefore) : undefined;
    await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
    const lineAfter = navEditor?.selection.active.line; // live selection — post-command state

    if (lineBefore === undefined || lineAfter === undefined || !(lineAfter < lineBefore)) {
        // Out of changes in the current file -> jump straight to the previous changed file, NO prompt.
        // Same rationale as goToNextDiff: the confirmation modal was removed entirely (see CHANGELOG v1.0.2).
        await openPreviousFile();
        return;
    }

    // Advanced to a previous hunk within this file. If it's tall, land showing its BOTTOM portion so
    // subsequent 'previous' presses step UP through it toward the top (the mirror of the next-change flow).
    if (stageCtx && lineAfter !== undefined) {
        await revealHunkOnLanding(stageCtx, lineAfter, "up", hunkBefore);
    }
};

// Thin queued wrappers are the single public/shared path used by direct keyboard commands and smart mouse
// navigation alike. Keeping the queue here (rather than in keybindings) covers every entry point identically.
const goToNextDiff = (): Promise<void> => serializeChangeNavigation(goToNextDiffOnce);
const goToPreviousDiff = (): Promise<void> => serializeChangeNavigation(goToPreviousDiffOnce);

const goToFirstOrNextFile = async () => {
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath (see goToNextDiff).
    if (!(await activeNavFilePath())) {
        await openFirstFile();
        return;
    }

    await openNextFile();
};

const goToLastOrPreviousFile = async () => {
    // BUG 13 (v1.2.9): tab-first "is anything under review?" check via activeNavFilePath (see goToNextDiff).
    if (!(await activeNavFilePath())) {
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

    // BUG 4 FIX (v1.2.9 — stage-and-advance was a silent no-op on a merge-conflict file, and skipped conflicts
    // as advance targets). Route BOTH the safety guard AND the advance-target list through the ONE shared list
    // builder getFileChanges() — the SAME list next/previous-scm-change navigation uses — so the stage-and-
    // advance family can reach + progress through EXACTLY the entries the nav family can. Previously the guard
    // checked only index/working/untracked (NEVER state.mergeChanges), so a pure merge-conflict file failed the
    // guard and this function returned as a silent no-op (no stage, no advance, no message), stranding the user
    // on the conflict; and the advance list (getUnstagedUris) also omitted merges, so advancing from a normal
    // file skipped over conflicts — an asymmetry with keyboard nav, which walks through them. getFileChanges
    // includes merge conflicts (as staged:false entries) in the correct SCM order, so deriving both from it
    // fixes both parts with no divergent merge-only branch. Read it BEFORE staging: getFileChanges snapshots
    // activeRepo.state at call time, so the target is computed against the pre-stage state (deterministic).
    const allChanges = await getFileChanges();

    // SAFETY GUARD: only act if the active file is actually a change (staged, unstaged, untracked, OR a merge
    // conflict). Without this, an accidental stage-and-advance while editing a clean/unrelated file would run
    // git add as a no-op then close that editor — a nasty surprise. Testing membership against getFileChanges()
    // keeps this guard and the advance list below reading from the SAME set, so they can never diverge again.
    if (!allChanges.some((c) => pathMatches(c.uri))) {
        return;
    }

    // The advance targets are the NON-STAGED entries (tracked unstaged + untracked/new + merge conflicts) in
    // SCM nav order. Staged entries are excluded because there's nothing to stage-and-advance FROM on them (the
    // staged-side early-return above already handled that case). Untracked/new files ARE included (git.openChange
    // opens them as a diff vs an empty original), so stage-and-advance lands on a brand-new file too.
    const advanceTargets = allChanges.filter((c) => !c.staged).map((c) => c.uri);

    const currentIndex = advanceTargets.findIndex(pathMatches);
    // Where to land after staging, by direction:
    //   "next"     -> the file AFTER the current one (top-to-bottom review); if it was the LAST, fall back to
    //                 the PREVIOUS one so we don't strand you. Not in the list -> the FIRST unstaged file.
    //   "previous" -> the file BEFORE the current one (bottom-to-top review); if it was the FIRST, fall back
    //                 to the NEXT one. Not in the list -> the LAST unstaged file.
    // The ?? handles the boundary; for the only-file case the fallback index is out of range and returns
    // undefined (-> close the editor below, nothing left to review). NOTE: this end-of-list guard is exactly
    // what the mouse (F18/F19) + the "+" button inherit for free — they call this SAME function, so the
    // at-the-end/at-the-bottom behavior is identical no matter how stage-and-advance is triggered.
    let targetUnstagedFile: vscode.Uri | undefined;
    if (currentIndex === -1) {
        targetUnstagedFile = direction === "next" ? advanceTargets[0] : advanceTargets[advanceTargets.length - 1];
    } else if (direction === "next") {
        targetUnstagedFile = advanceTargets[currentIndex + 1] ?? advanceTargets[currentIndex - 1];
    } else {
        targetUnstagedFile = advanceTargets[currentIndex - 1] ?? advanceTargets[currentIndex + 1];
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
    // BUG 11 FIX (v1.2.9 — stage-and-advance landed nowhere on an untracked target with
    // git.untrackedChanges="separate"): route the final open through the SHARED openChangeEntry (the same
    // function nav's openNextFile/openPreviousFile use) instead of a raw git.openChange. In "separate" mode
    // git.openChange(untrackedUri) resolves nothing AND does NOT throw, so after closing the current editor
    // the target never opened and the user was stranded on a blank/closed editor. openChangeEntry's unstaged
    // path has a shown-tab verification + showTextDocument fallback that handles exactly this silent-no-op —
    // so the mouse/keyboard/"+" stage-and-advance now inherits it for free, matching plain navigation.
    await openChangeEntry({ uri: targetUnstagedFile, staged: false });
};

// BUG 13 FIX (v1.2.9): serialize getActiveFilePath so its clipboard save/blank/restore dance can't interleave.
// The clipboard hack (below) is inherently racy: two concurrent calls (Ethan mashing alt+.) could have call B
// read the ALREADY-BLANKED clipboard as its "original" and later restore "" — permanently losing his real
// clipboard. A single in-flight promise makes concurrent callers share ONE dance instead of overlapping.
let getActiveFilePathInFlight: Promise<string> | undefined;
const getActiveFilePath = async (): Promise<string> => {
    if (getActiveFilePathInFlight) {
        return getActiveFilePathInFlight; // a dance is already running — reuse it rather than starting a racing one
    }
    getActiveFilePathInFlight = (async (): Promise<string> => {
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
    })();
    try {
        return await getActiveFilePathInFlight;
    } finally {
        getActiveFilePathInFlight = undefined; // clear so the NEXT (non-overlapping) press runs a fresh lookup
    }
};

// BUG 13 FIX (v1.2.9): the four navigation entry-guards used to call getActiveFilePath() just to ask "is there
// a file under review?" — but when focus was in the SCM panel (activeTextEditor undefined, common in Ethan's
// flow) that fired the clipboard save/blank/restore hack on EVERY press, transiently blanking his clipboard.
// This resolves the active file focus-INDEPENDENTLY from the active TAB first (currentReviewFileUri — the same
// shared "which file is under review" predicate the nav + badge use), then the focused editor's uri, and only
// falls back to the clipboard-based getActiveFilePath for genuinely non-textual active files (images — which
// have neither a diff-tab input nor a text editor). So the common review path never touches the clipboard.
// Returns undefined only when there is truly nothing open to act on.
const activeNavFilePath = async (): Promise<string | undefined> => {
    const fromTab = currentReviewFileUri() ?? vscode.window.activeTextEditor?.document.uri;
    if (fromTab) {
        return fromTab.path;
    }
    const fallback = await getActiveFilePath(); // last-ditch, non-textual (image) case only
    return fallback || undefined;
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
// smart-back command registrations for the full rationale on why we detect the review view via the active
// tab's input type rather than the `isInDiffEditor` keybinding context.
//
// A review view is ANY of the shapes the keyboard next/previous-scm-change handle — a side-by-side diff
// (modified/renamed), a new/untracked file's plain editor, or a deleted file's HEAD-blob plain editor —
// each detected by REUSING the extension's existing predicates so the mouse is a thin wrapper over the
// same nav functions. All route to the scm-change commands; everything else -> browser nav. See the body.
//
// direction === "forward":  review -> PREVIOUS SCM change (intentionally flipped) | otherwise -> navigateForward
// direction === "back":     review -> NEXT SCM change (intentionally flipped)     | otherwise -> navigateBack
async function smartNavigate(direction: "forward" | "back") {
    // "In review" = the active tab is a change-review view that next/previous-scm-change know how to drive.
    // GENERAL PRINCIPLE (Ethan 2026-07-04): the mouse buttons must be THIN WRAPPERS over the SAME nav
    // functions the keyboard uses, so EVERY edge case the keyboard's next/previous-scm-change handle works via
    // the mouse automatically — not by patching one file-state at a time. So this gate must recognise ALL the
    // review views the keyboard handles, and route them to next/previous-scm-change. There are THREE shapes VS
    // Code opens a reviewed git change in — we recognise each by REUSING the extension's existing predicates
    // (no divergent per-case checks), and everything else falls through to plain browser back/forward:
    //
    //   1. MODIFIED / RENAMED file  -> a side-by-side text DIFF tab (TabInputTextDiff). This is what
    //      git.openChange opens when an original side exists. Routing here gives hunk navigation, cross-file
    //      rollover, AND the v1.2.6 tall-hunk staging (all live inside next/previous-scm-change) for free.
    //
    //   2. NEW / UNTRACKED ("U") / staged-new file  -> a PLAIN file: editor (TabInputText). A whole-new file
    //      has NO original side, so VS Code opens an ordinary editor, not a diff. Detected by REUSING
    //      newFileScrollEditor() — the SAME single-source-of-truth gate next/previous-scm-change use for the
    //      5-line new-file scroll (plain TabInputText + file: scheme + isFullyAddedFile git-status + visible
    //      editor). CRUCIAL: because that gate requires isFullyAddedFile, a MODIFIED file that the user opened
    //      as a plain editor to EDIT (not review — its review view is the DIFF, case 1) is NOT matched here, so
    //      we never hijack browser back/forward while they're just editing a changed file.
    //
    //   3. DELETED file  -> a PLAIN editor of the HEAD blob under a git: uri (TabInputText, git: scheme). It has
    //      no on-disk file: side, so newFileScrollEditor() (file:-only) correctly skips it. On the keyboard,
    //      next-scm-change on a deleted file falls straight through to the next changed file (openNextFile); the
    //      mouse must do the same. Detected by resolving the git: uri back to its on-disk path (toFilePathUri)
    //      and confirming it is an ACTUAL current change (isChangeFileUri) — the SAME shared predicate the tab
    //      badge + stageCurrentFile use — so a random HEAD/history view of a clean file is NOT treated as review.
    //
    // Before v1.2.8 the gate was case 1 ONLY (`instanceof TabInputTextDiff`), so on every non-diff review view
    // (new/untracked/deleted files) the mouse fell through to browser history and did nothing useful — while the
    // keyboard alt+,/alt+. worked, because they call next/previous-scm-change directly. This is that fix, made
    // general so future review shapes are covered by the shared predicates rather than another one-off patch.
    let inReview = false;
    try {
        // FOCUS-INDEPENDENT detection: read the active tab of the active group, not the focused editor. This is
        // what makes the mouse buttons "just work" even when focus is in the SCM panel during review.
        const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        const input = tab?.input;
        // Case 1 — modified/renamed diff. instanceof is safe even if `input` is undefined or some other type.
        const isDiff = input instanceof vscode.TabInputTextDiff;
        // Case 2 — new/untracked/staged-new plain file: editor. newFileScrollEditor() returns a TextEditor only
        // for a genuine whole-new-file review view (else undefined); its own body is fully guarded.
        const isNewFileView = !isDiff && newFileScrollEditor() !== undefined;
        // Case 3 — deleted file's HEAD-blob plain editor (git: scheme). Only a plain TabInputText tab can be one;
        // resolve to the on-disk path and require it to be an actual change so we don't match arbitrary git:
        // history views. (file:-scheme plain editors are handled by case 2, which correctly excludes modified
        // files being edited — so we deliberately restrict case 3 to the git: scheme.)
        let isDeletedFileView = false;
        if (!isDiff && !isNewFileView && input instanceof vscode.TabInputText && input.uri.scheme === "git") {
            const resolved = toFilePathUri(input.uri); // git: uri -> on-disk file: path (path lives in the query)
            isDeletedFileView = resolved ? isChangeFileUri(resolved) : false;
        }
        //   4. MERGE-CONFLICT file  -> a 3-way TabInputTextMerge editor (BUG 1, 2026-07-04). The keyboard
        //      next/previous-scm-change handle conflicts (getFileChanges includes state.mergeChanges,
        //      getActiveChange + currentReviewFileUri duck-type the merge editor), so the mouse must too — else
        //      it silently does browser back/forward on a conflict while the keyboard navigates the changeset.
        //      Detected via the SAME shared isMergeEditorInput predicate currentReviewFileUri/getActiveChange use.
        const isMergeView = !isDiff && !isNewFileView && !isDeletedFileView && isMergeEditorInput(input);
        //   5. BINARY / IMAGE change  -> a TabInputCustom (custom editor) tab (BUG 2, 2026-07-04). git.openChange
        //      shows an image/binary diff as a custom editor, not TabInputTextDiff/TabInputText, so none of the
        //      cases above match and the mouse fell through to browser nav — strictly weaker than the keyboard
        //      (getActiveChange can still resolve the path for it). Resolve the custom tab's on-disk uri and
        //      require it to be an ACTUAL change (toFilePathUri + isChangeFileUri — the SAME shared predicates)
        //      so we only treat a real binary CHANGE view as review, never an arbitrary custom-editor tab.
        let isBinaryChangeView = false;
        if (!isDiff && !isNewFileView && !isDeletedFileView && !isMergeView && input instanceof vscode.TabInputCustom) {
            const resolved = toFilePathUri(input.uri);
            isBinaryChangeView = resolved ? isChangeFileUri(resolved) : false;
        }
        //   6. PLAIN MERGE-CONFLICT file (Codex review 2026-07-04, plain-merge follow-up). Case 4 only catches the
        //      3-way TabInputTextMerge editor, which VS Code opens only when git.mergeEditor=true. With the DEFAULT
        //      git.mergeEditor=false a conflict opens as the PLAIN working file (file: scheme TabInputText) with
        //      conflict markers — so the mouse fell through to browser nav while the keyboard navigated it
        //      (getFileChanges includes mergeChanges). Match a plain file: editor whose path is SPECIFICALLY in
        //      mergeChanges (isMergeConflictFileUri, NOT the general isChangeFileUri) so an ordinary modified file
        //      opened in a plain editor is still deliberately excluded from mouse change-nav (same intent as case 3).
        let isPlainMergeFileView = false;
        if (
            !isDiff && !isNewFileView && !isDeletedFileView && !isMergeView && !isBinaryChangeView &&
            input instanceof vscode.TabInputText && input.uri.scheme === "file"
        ) {
            const resolved = toFilePathUri(input.uri);
            isPlainMergeFileView = resolved ? isMergeConflictFileUri(resolved) : false;
        }
        inReview = isDiff || isNewFileView || isDeletedFileView || isMergeView || isBinaryChangeView || isPlainMergeFileView;
    } catch {
        // Defensive fallback: on a very old host where TabInputTextDiff doesn't exist (or newFileScrollEditor
        // throws) the lines above could throw. Fall back to the legacy heuristic — treat it as review only if
        // there's no plain active text editor (a side-by-side diff has no single activeTextEditor in the classic
        // sense). Worst case we mis-route to plain navigation, which is the harmless default. Never a dead click.
        inReview = !vscode.window.activeTextEditor;
    }

    // NOTE: the REVIEW branch is INTENTIONALLY flipped relative to the navigation branch (Ethan's preference,
    // 2026-06-20: "the diff one should be flipped, I know it's weird"). So the FORWARD button goes to the
    // PREVIOUS change while reviewing, and the BACK button goes to the NEXT change. This flip now covers ALL
    // review views (diff + new-file + deleted + merge + binary) identically — Ethan confirmed 2026-07-04 the
    // mouse direction "feels perfect", so we only fix WHICH views engage change-nav; the direction is unchanged.
    // Outside a review view the buttons keep their normal meaning (forward = navigateForward, back = navigateBack).
    // The flip is a MOUSE-BUTTON preference only. It must never leak onto keyboard keys again: that's the
    // v1.2.5 QWERTY bug — these commands held the default alt+./alt+, (physical >/<) keyboard keys, so QWERTY
    // users got reversed >/< navigation while Dvorak (whose >/< keys type v/w -> next/previous-scm-change)
    // stayed correct. Keyboard >/< now binds the canonical scm-change commands directly in package.json.
    //
    // BUG 3 FIX (v1.2.9 — smart mouse corrupted lastNavDirection, making the "+" button advance the WRONG way):
    // the review branch used to delegate via executeCommand("better-git-vscode.next-scm-change"/"previous-...").
    // Those two COMMAND HANDLERS write the module-level lastNavDirection (next-scm-change sets "next",
    // previous-scm-change sets "previous"). Because of the flip above, the smart-FORWARD button routed to
    // previous-scm-change and set lastNavDirection="previous"; so after reviewing FORWARD with the mouse, the
    // "+" button (which reads lastNavDirection) then advanced BACKWARD — the exact wrong-way bug the design
    // comment at the top of this file (lines ~20-23) says the smart buttons must NEVER cause. Fix: call the
    // underlying goToNextDiff()/goToPreviousDiff() DIRECTLY. They are the single-source-of-truth navigation
    // functions; the command handlers are thin wrappers whose ONLY extra behaviour is the lastNavDirection
    // write. Calling the functions gives byte-identical navigation while restoring the invariant that the
    // flipped smart mouse buttons never touch lastNavDirection, so the "+" keeps advancing in Ethan's actual
    // review direction. (F18/F19 were already immune — they pass an explicit direction.)
    // v1.2.17 narrow no-tab entry: keep normal browser history for EVERY active tab, including non-file
    // webviews such as Settings, Welcome, and extension pages. Do NOT use activeNavFilePath() as this gate:
    // webviews intentionally have no file path and would be mistaken for "nothing open", hijacking their
    // useful navigateBack/navigateForward history; its last-ditch path lookup can also invoke the BUG 13
    // clipboard save/blank/restore workaround on every mouse press. The tab model answers the real question
    // synchronously and without side effects: is there an active tab in the group the user is currently using?
    //
    // Check ONLY activeTabGroup, not every group. A tab open in a different split is not the current browser-
    // navigation context and should not prevent review entry when the active group itself is genuinely empty.
    // Conversely, any active tab in the active group — file, diff, Settings, Welcome, custom editor, webview —
    // must preserve normal browser navigation. In the one truly-empty-active-group state, let the mouse start
    // review with Ethan's existing intentional direction flip. This may give up VS Code's "reopen last
    // navigation position" opportunity when that group has no tab, but the explicit review command is more
    // useful after stage-and-advance closed the final reviewed file.
    const hasActiveTab = vscode.window.tabGroups.activeTabGroup.activeTab !== undefined;
    if (!inReview && !hasActiveTab) {
        if (direction === "forward") {
            await goToPreviousDiff(); // flipped: forward button -> previous/last review entry
        } else {
            await goToNextDiff(); // flipped: back button -> next/first review entry
        }
        return;
    }

    if (direction === "forward") {
        if (inReview) {
            await goToPreviousDiff(); // flipped: forward button -> PREVIOUS change (does NOT write lastNavDirection)
        } else {
            await vscode.commands.executeCommand("workbench.action.navigateForward");
        }
    } else {
        if (inReview) {
            await goToNextDiff(); // flipped: back button -> NEXT change (does NOT write lastNavDirection)
        } else {
            await vscode.commands.executeCommand("workbench.action.navigateBack");
        }
    }
}

export function deactivate() {}
