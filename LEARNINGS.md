# Learnings

Per-repo institutional memory for fixes. Every entry below is a real bug we hit + how we solved it. Check this file BEFORE attempting a same-looking fix.

Maintained by the `learnings` skill — see `~/.claude/skills/learnings/skill.md`.

## Format

Each entry looks like:

```
---
**Date:** YYYY-MM-DDTHH:MM:SSZ
**Trigger:** <voice N / message snippet / null>
**Symptom:** <what was visible>
**Root cause:** <what we actually found>
**Fix:** <file:line + short prose + commit SHA>
**Guard:** <test / lint / watchdog / comment that prevents regression — or 'none'>
---
```

## Entries

(newest first)

---
**Date:** 2026-07-07T13:09:30Z
**Trigger:** Ethan report 2026-07-07: 'go prev change in a large block, at the TOP of that hunk it LOOPS BACK TO THE BOTTOM instead of going to the previous change'
**Symptom:** Stepping UP through a tall hunk (Alt+, previous-scm-change): on reaching the TOP of the hunk it looped back to the BOTTOM of the same hunk instead of advancing to the previous change — an infinite within-hunk loop, could never reach the previous change. (Down direction was fixed in v1.2.10; the up branch never got the symmetric treatment.)
**Root cause:** stepTallHunk UP branch relied SOLELY on viewport-derived remainingAbove<=0 to decide 'top reached -> advance', with NO caret-derived signal — the exact asymmetry the v1.2.10 down fix removed for the bottom edge (which added caret>=hunk.end). When render slack/built-in nav left top a hair off hunk.start, remainingAbove never cleanly hit <=0, so the press re-entered the step path (its newTop=top-step fallback could scroll ABOVE the hunk); and when the built-in advance did fire it could re-land inside the same merged '+ run' hunk (which can span multiple VS Code change stops), then revealHunkOnLanding(up) re-showed that hunk's bottom -> loop.
**Fix:** src/extension.ts stepTallHunk up-branch made the EXACT mirror of down: (1) caret<=hunk.start -> return false (definitively advance; final step pins caret to hunk.start); (2) remainingAbove<=0 -> advance; (3) FINAL up-step (top-step<=minTop, minTop=hunk.start) reveals hunk.start at the TOP via revealTopAndPinCursor (AtTop near doc-top never clamps, unlike AtTop near EOF going down) and parks caret at hunk.start so signal (1) fires next press; else normal step max(top-step,minTop). PLUS belt-and-braces anti-loop guard: revealHunkOnLanding takes avoidHunk (the hunk caret was in before the built-in advance); if the advance re-landed in the SAME hunk (identity compare on once-parsed ctx.hunks) it skips the reveal so the viewport can't bounce back to that hunk's far edge. Both goToNextDiff/goToPreviousDiff pass hunkBefore. Symmetry documented in-code so it can't drift again.
**Commit:** pending-on-branch-fix/tall-hunk-up-loop
**Guard:** Down and up branches now provably symmetric (same 3-stage shape, mirrored edges), commented as a symmetry contract. debugLogging output channel logs every up/down decision (caret/viewport/hunk/minTop/maxTop/remaining) so any future stick/loop is diagnosable instantly. Anti-loop guard covers ALL four entry points (keyboard Alt+./Alt+,, smart mouse fwd/back via smartNavigate->goToNext/PreviousDiff, stage buttons). lint+tsc+package green. new-file 5-line scroll already symmetric+loop-free (both edges return false to defer).
---

---
**Date:** 2026-07-04T22:30:52Z
**Trigger:** Mini keyboard-emulation test on v1.2.9, evidence /tmp/better-git-vscode-tall-hunk-evidence-129/ (2026-07-04)
**Symptom:** Tall-hunk staging (next-scm-change stepping DOWN through a hunk taller than the viewport) got permanently STUCK a few lines short of the bottom (e.g. Ln 202 on a 240-line hunk, visible ~197-235): repeated Alt+. no-op'd, never revealed the tail lines 236-240, never advanced to the next file. Alt+, (up) worked fine.
**Root cause:** The final down-step in stepTallHunk computed a target top of hunk.end-visLines+1 and revealed it with revealRange(AtTop). Near end-of-file VS Code CANNOT place that line at the top of the viewport (it clamps the scroll — no screenful of lines below it), so the viewport silently didn't move. But remainingBelow = hunk.end - bottom was computed from the (unclamped) geometry and stayed > 0, so the press kept trying to step and never hit the 'reached bottom -> advance' branch. Infinite no-op. UP was unaffected: AtTop of a line near the TOP of the doc (hunk.start) is always reachable.
**Fix:** src/extension.ts stepTallHunk down-branch: (1) if caret >= hunk.end -> return false (definitively advance; the final step parks caret at hunk.end). (2) the FINAL down-step (top+step >= maxTop where maxTop=hunk.end-visLines+1) now reveals hunk.end at the BOTTOM via new revealBottomAndPinCursor (RevealType.Default scrolls DOWN, never EOF-clamped) instead of AtTop-an-unreachable-line — guaranteeing the tail shows — and pins caret to hunk.end so signal (1) advances on the next press. Normal (non-final) steps still AtTop as before. Added 'Better Git' OutputChannel + better-git-vscode.debugLogging setting (default false) logging every step decision.
**Commit:** d0dd664 (PR #20, squash-merged; published as v1.2.10)
**Guard:** debugLogging output channel makes the next stuck case diagnosable instantly (logs direction/viewport/hunk/caret/target/remaining/decision). Fix is layered on the existing span<=threshold and remainingBelow<=0 guards; non-final steps unchanged; UP direction unchanged. lint+tsc+package green.
---

---
**Date:** 2026-07-04T21:38:14Z
**Trigger:** Ethan edge-case-audit ship dispatch 2026-07-04 (Codex authorized)
**Symptom:** Codex review of the v1.2.9 edge-case-audit batch found 4 residual holes where merge-conflict / binary-image review views still diverged from the keyboard: (1) openChangeEntry's silent-no-op verifier only recognized diff/plain-text tabs, so a correctly-opened merge editor or binary/image custom editor was mistaken for a failed open and REPLACED with the raw file via showTextDocument; (2) backward new-file rollover ran isFullyAddedFile for staged-new INDEX_ADDED targets (which open as side-by-side diffs, not plain editors) — wasted the 8x30ms newFileScrollEditor retry then skipped the compareEditor.previousChange landing, reintroducing land-at-top-then-skip; (3) currentReviewFileUri had no TabInputCustom branch so binary/image tabs were invisible to repo-selection + late-collapse; (4) plain merge conflicts (default git.mergeEditor=false open as a plain file: editor, in mergeChanges) were missed by isChangeFileUri and smartNavigate, so mouse fell through to browser nav
**Root cause:** Each new review-shape (merge editor, binary custom editor, plain merge conflict) was added to SOME entry points but not the shared predicates the others rely on; isChangeFileUri excluded mergeChanges; the openChangeEntry verifier kept a local diff/plain-only copy instead of reusing currentReviewFileUri
**Fix:** src/extension.ts: (1) openChangeEntry unstaged silent-no-op guard now resolves the shown file via shared currentReviewFileUri() (merge+custom aware) instead of a local TabInputTextDiff/TabInputText-only copy; (2) backward new-file rollover gated on !fileChanges[prevIndex].staged so staged-new diffs take compareEditor.previousChange; (3) added TabInputCustom branch to currentReviewFileUri (toFilePathUri+isChangeFileUri); (4) isChangeFileUri now includes repo.state.mergeChanges + new isMergeConflictFileUri helper (mergeChanges-only) + smartNavigate case 6 matches plain file: TabInputText in mergeChanges — while STILL excluding an ordinary modified file opened in a plain editor from mouse change-nav
**Commit:** 2ed18fd
**Guard:** 3 rounds of Codex xhigh review until CLEAN; lint+tsc+webpack green each round; shared-predicate routing means every entry point inherits the same review-shape recognition
---

---
**Date:** 2026-07-04T21:14:19Z
**Trigger:** Ethan edge-case audit dispatch 2026-07-04
**Symptom:** Edge-case audit: mouse/+/keyboard entry points diverged across file-states — smart mouse did browser-nav on merge-conflict + binary views; smart mouse corrupted lastNavDirection so '+' advanced wrong way; stage-and-advance silent no-op on merge conflicts + on untracked targets (untrackedChanges=separate); backward rollover into a new file skipped it; dual-state deleted files dead-ended nav; tall-hunk parsed wrong diff for partially-staged files + skipped last up-to-4 changed lines (tiny tail) + up-direction bounce; getFileChanges threw when git not ready; late worktree collapse hijacked active diff; getActiveFilePath clipboard race
**Root cause:** Each entry point re-implemented / bypassed a guard the shared chokepoint already had, or a shared predicate had a hole (merge/binary review shapes, HEAD-vs-working diff source, staged=null forcing findCurrentIndex ambiguity guard, non-null-asserted git.exports)
**Fix:** src/extension.ts: (1) extracted isMergeEditorInput shared predicate, used in currentReviewFileUri+getActiveChange+smartNavigate gate; (2) added TabInputCustom(binary) branch to smartNavigate gate via toFilePathUri+isChangeFileUri; (3) smartNavigate calls goToNextDiff/goToPreviousDiff DIRECTLY (not the scm-change commands that write lastNavDirection); (4) stageCurrentFileAndAdvance guard+advance list derived from getFileChanges().filter(!staged) (includes mergeChanges); (5) stage-advance final open via shared openChangeEntry not raw git.openChange; (6) openPreviousFile lands new-file target at LAST line via newFileScrollEditor gate (only when isFullyAddedFile target, no latency on diff path); (7) getActiveChange plain-editor branch returns staged=false not null; (8) getModifiedSideHunks unstaged side parses working-vs-INDEX (repo.diff(false)+extractFileDiffSection) not diffWithHEAD; (9) stepTallHunk TINY_TAIL removed (edge guard now remaining<=0) — also fixes up-bounce; (10) getFileChanges uses ?.exports?.getAPI(1)+getPrimaryRepository, returns [] on miss; (11) collapseWorktreesKeepingPrimaryExpanded skips reveal when currentReviewFileUri() defined; (12) getActiveFilePath serialized via in-flight promise, 4 nav guards use tab-first activeNavFilePath
**Commit:** pending-on-branch-fix/edge-case-audit
**Guard:** All fixes routed through ONE shared function/predicate (no divergent per-case branch); mouse at-the-end/at-the-bottom guards inherited for free via shared stageCurrentFileAndAdvance/openChangeEntry/goToNextDiff. Extensive BUG N in-file comments. lint+tsc+package green. Direction semantics unchanged (Ethan confirmed mouse flip feels perfect)
---

---
**Date:** 2026-07-04T20:31:06Z
**Trigger:** Ethan 2026-07-04: mouse back/forward don't navigate on U/new files but keyboard does; 'they call the exact same function'.
**Symptom:** smart mouse Forward/Back buttons (F13->smart-back, F17->smart-forward) did NOT navigate on untracked/new ('U') files — no 5-line new-file scroll, no advance; worked on modified files. Keyboard alt+,/alt+. DID work on new files (mouse/keyboard inconsistency).
**Root cause:** smartNavigate() decided 'in review?' by checking ONLY tab.input instanceof vscode.TabInputTextDiff. A whole-new/untracked file has no original side so VS Code opens it as a PLAIN TabInputText editor, not a diff -> check was false -> buttons fell through to workbench.action.navigateForward/Back (browser history) instead of next/previous-scm-change. next/previous-scm-change (bound to the keyboard keys) handle new files via newFileScrollEditor(), which the mouse path never reached.
**Fix:** src/extension.ts smartNavigate() — GENERALIZED (Ethan follow-up: mouse buttons must be thin wrappers over the SAME nav fns as the keyboard so EVERY edge case works via shared code, not per-case patches). inDiff -> inReview covering ALL 3 shapes VS Code opens a reviewed git change in, each via an EXISTING predicate: (1) modified/renamed = TabInputTextDiff (gets hunk nav + tall-hunk staging + rollover free); (2) new/untracked/staged-new = plain file: editor via newFileScrollEditor() (the SAME gate next/previous-scm-change use for the 5-line scroll; requires isFullyAddedFile so a MODIFIED file opened plainly to EDIT is NOT hijacked — its review view is the diff); (3) deleted = plain git:-scheme editor of the HEAD blob, detected by toFilePathUri(uri)+isChangeFileUri(path) (the shared badge/stage predicate; git:-only so it can't catch an edited file: modified file). inReview -> previous/next-scm-change (intentional mouse flip UNCHANGED); everything else -> browser nav. F18/F19 stage-and-next/previous-changed-file ALREADY route through shared stageCurrentFileAndAdvance() (same as keyboard shift+alt+.,/ + the '+' button) so no change needed there. Kept try/catch + activeTextEditor fallback.
**Commit:** a1de05a (PR #17, new/untracked fix) then 6c2048c (PR #18, generalized to all 3 review shapes); both squash-merged, shipped in v1.2.8
**Guard:** All three cases reuse existing single-source-of-truth predicates (newFileScrollEditor ~L1383, isChangeFileUri ~L695, toFilePathUri ~L714) — the SAME ones next/previous-scm-change / the badge / stage use — so mouse + keyboard can't diverge on what counts as which change type. isDiff short-circuits so the modified-file diff path is byte-unchanged; case2's isFullyAddedFile + case3's git:-only scheme guard jointly prevent hijacking a modified/clean file opened for editing (browser nav preserved). Codex xhigh review (both the initial + generalized diff): LGTM / no correctness issues; confirmed downstream getActiveChange resolves plain git: tabs so deleted-file rollover has an anchor. lint+tsc+package green. Extensive in-file comments enumerating the 3 review shapes + why each predicate.
---

---
**Date:** 2026-07-04T20:14:11Z
**Trigger:** Ethan 2026-07-04: 'it should call the exact same function ... as if we held shift and alt and greater-than or less-than ... based on whatever the last jump was, if I went next or previous.'
**Symptom:** Editor-title '+' button only STAGED the current file — Ethan then had to grab the keyboard to jump to the next change, breaking the mouse-only review flow.
**Root cause:** The editor/title menu pointed at better-git-vscode.stage-current-file (stage, no navigate); there was no mouse path that both staged and advanced, and no memory of which direction (next/previous) he was reviewing in.
**Fix:** src/extension.ts: added module-level lastNavDirection ('next'|'previous', default 'next') set by next/previous-scm-change, next/previous-changed-file, and stage-and-next/previous (NOT the smart mouse cmds — their in-diff direction is intentionally flipped). New command better-git-vscode.stage-current-file-and-advance calls the SAME stageCurrentFileAndAdvance(lastNavDirection) that the Shift+Alt+./,keyboard shortcuts use. package.json editor/title menu repointed from stage-current-file to stage-current-file-and-advance (kept $(add) icon + gitOpenRepositoryCount!=0 when-clause). stage-current-file stays registered for anyone who bound it.
**Commit:** b88e635 (PR #16, squash-merged; published as v1.2.7)
**Guard:** stageCurrentFileAndAdvance's isChangedFile guard makes the button a safe no-op on non-change editors (never errors). Both keyboard cmds and the button share one function (no fork). Thorough comments at the lastNavDirection decl + each nav command + the new command registration. lint+tsc+package green.
---

---
**Date:** 2026-07-04T19:57:11Z
**Trigger:** Ethan voice note 2026-07-04: 'do it in stages... but obviously get the UX right for this... same with going to previous change... I'm currently having to get my fingers off the keyboard quite often.'
**Symptom:** Tall hunks (taller than the viewport) forced Ethan off the keyboard: next-change landed at the hunk TOP, the rest ran off the bottom, so he had to manually scroll then press next again. Wanted next/prev-change to step through a tall hunk in stages.
**Root cause:** VS Code's built-in compareEditor.next/previousChange only exposes hunk STARTS (moves the caret to each change), never a hunk's END, and TextEditor.diffInformation (the only public API to read a diff editor's change regions) is proposed API, unusable on engine ^1.83. So the extension had no way to know a hunk overflowed the screen.
**Fix:** src/extension.ts: added a stateless/viewport-derived tall-hunk staging interposer in goToNextDiff/goToPreviousDiff. getModifiedSideHunks() parses the file's unified diff from the git API (repo.diffWithHEAD(path) unstaged / repo.diffIndexWithHEAD(path) staged) — reads @@ +newStart,newCount @@ headers, collects maximal runs of + lines as modified-side hunk ranges. Each press recomputes live from viewport (editor.visibleRanges) + caret + hunks: if caret is in a hunk taller than the viewport and its far edge is off-screen, scroll ~one viewport-minus-overlap and consume the press; else defer to the unchanged built-in nav. NO persisted state machine — the viewport+caret ARE the state, so reverse-direction / file-switch / caret-move resets are free. 4 settings: hunkStagingEnabled/Threshold(0=auto viewport)/LineStep(0=auto)/Overlap(4).
**Commit:** a45a1d9 (PR #15, squash-merged; published as v1.2.6)
**Guard:** Interposer only runs for TabInputTextDiff and only when it decides the caret is in a tall hunk whose far edge is off-screen; every other case returns false and the pre-existing navigation runs byte-for-byte (composes with new-file scroll, deleted files, cross-file rollover, smart mouse cmds, dvorak/qwerty gating). All defensive (try/catch, empty-diff->defer) so a parse failure degrades to plain hunk nav, never a dead keypress. Extensive design-rationale comments in-file. lint+tsc+package green.
---

---
**Date:** 2026-07-04T16:24:01Z
**Trigger:** Ethan voice/message 2026-07: '> and < next and prev are fukt on qwerty ... did u just patch the dvorak one?? ... the extra dvorak mode should be a thin wrapper on top of actual working behaviour, not redefining the functionality.'
**Symptom:** better-git-vscode: next/previous SCM change (the headline > and < keys, alt+. / alt+,) were BROKEN on QWERTY — > navigated BACKWARD through diff changes, < navigated FORWARD, and outside a diff they did editor history navigation instead of change navigation. Dvorak layout was PERFECT (source of truth).
**Root cause:** The QWERTY physical >/< keys (alt+./alt+,) were bound to smart-forward/smart-back — the MOUSE-button commands (Karabiner F13/F17) whose in-diff direction was INTENTIONALLY REVERSED for thumb-buttons in commit 6043d05 (v0.8.3, 'the diff one should be flipped, I know it's weird'). The keyboard keys silently inherited that mouse flip. Dvorak was immune because its physical >/< keys type v/w, bound alt+v/alt+w straight to the canonical next-scm-change/previous-scm-change commands. So the working Dvorak path was never touched by the mouse flip — it was the correct reference all along.
**Fix:** package.json contributes.keybindings: bound QWERTY alt+. -> next-scm-change and alt+, -> previous-scm-change (gated !config.better-git-vscode.dvorakMode), i.e. the SAME canonical commands Dvorak's alt+v/alt+w run — one behaviour, defined once, Dvorak is now purely a character-remap of the same physical keys (thin wrapper, not a fork). Dropped legacy QWERTY alt+z/alt+a defaults (alt+z shadowed VS Code built-in Toggle Word Wrap). smart-forward/smart-back are mouse-only now: NO default QWERTY keyboard binding; they keep alt+./alt+, ONLY under dvorakMode (those chars sit on different physical keys there) so the Dvorak setup is byte-identical to v1.2.4 (verified by simulating both when-clause states). Dvorak bindings/behaviour completely unchanged.
**Commit:** 556ef2d
**Guard:** Simulate live keybindings per dvorakMode state (python/node over contributes.keybindings) — BOTH modes must have ZERO key collisions AND dvorakMode=true must be byte-identical to the prior release. The reversed-direction flip in smartNavigate() is MOUSE-ONLY and must never hold a keyboard default again (comments at both the smart command registration and smartNavigate() in extension.ts, plus _comment_dvorakMode_keybindings in package.json, document this). CHANGELOG 1.2.5 records the root cause.
---

---
**Date:** 2026-07-04T12:31:45Z
**Trigger:** Ethan request 2026-07: keep main worktree expanded, collapse others
**Symptom:** Want to keep the primary/main SCM repository expanded while collapsing only the other git worktrees in VS Code's Source Control view
**Root cause:** VS Code exposes NO command to collapse or expand a SINGLE repository — only workbench.scm.action.collapseAllRepositories / expandAllRepositories which iterate scmViewService.visibleRepositories and act on ALL at once. The per-node tree.collapse()/tree.expand() are internal to SCMView, unreachable from an extension.
**Fix:** Collapse all repos, then re-expand ONLY the primary by leveraging VS Code's built-in scm.autoReveal: SCMView.onDidActiveEditorChange calls tree.expandTo(resource) (expands all ancestors incl the repo header) for the active editor's matching SCM resource. So after collapseAllRepositories, open one of the PRIMARY repo's changed files (showTextDocument, preview+preserveFocus) to fire auto-reveal and re-expand just that repo's section. Detect primary = repo whose rootUri matches workspaceFolders[0] (worktrees live outside the folder), fallback git.repositories[0]. Small setTimeout(120ms) so the reveal lands after the collapse on the tree-op sequencer.
**Commit:** 3cc8b6f (v1.2.4, PR #13)
**Guard:** Thoroughly commented in src/extension.ts (collapseWorktreesKeepingPrimaryExpanded + getPrimaryRepository + big WHY block). Limits documented: relies on scm.autoReveal (default on), opens a preview tab, primary with no changes stays collapsed.
---

---
**Date:** 2026-07-04T12:11:55Z
**Trigger:** v1.2.2/1.2.3 publish task 2026-07-04
**Symptom:** vsce publish fails TF400813 expired PAT even though OC published v1.2.1 the day before
**Root cause:** OC's fresh PAT was stored only in the Mini's keytar 'vscode-vsce' entry (via npx vsce login) + bridged to MBP once but never persisted; MBP keychain + everyone's assumptions still pointed at the old dead token
**Fix:** Recovered the raw 84-char PAT from the archived agent-bridge message (~/.agent-bridge/inbox/.archive/claude-code/default/2026-07-03T16-17-33*.json), verified with vsce verify-pat, stored durably as Keychain item 'vsce-pat-ethansk' acct EthanSK on BOTH machines; publish with VSCE_PAT="$(security find-generic-password -s vsce-pat-ethansk -a EthanSK -w)" npx @vscode/vsce publish
**Commit:** 35ea5cb
**Guard:** Keychain entry vsce-pat-ethansk on MBP+Mini + reference_vscode_marketplace_publish.md updated
---

---
**Date:** 2026-07-04T11:58:23Z
**Trigger:** Ethan request: 'make better-git-vscode minimize the worktrees if there are any when opening / reloading window'
**Symptom:** Git worktrees / multiple repos render EXPANDED in the Source Control panel on every window open/reload; noisy with several worktrees
**Root cause:** VS Code has no public API to persist/default the SCM repository/worktree section collapse state (upstream microsoft/vscode#322318). The only built-in that collapses the repo section headers is the view action workbench.scm.action.collapseAllRepositories, which no-ops unless the Source Control view is the ACTIVE sidebar (its handler resolves the target via getActiveViewWithId('workbench.scm')). Repos also populate asynchronously, so collapsing too early finds nothing to collapse.
**Fix:** v1.2.2: collapseScmRepositories() reveals SCM via workbench.view.scm THEN runs workbench.scm.action.collapseAllRepositories (both in try/catch). runCollapseWorktreesOnStartup() polls the git API (getAPI(1).repositories.length) every 400ms up to ~10s, only collapses when >=2 repos, and briefly listens to onDidOpenRepository for ~12s to catch late worktrees. Added setting better-git-vscode.collapseWorktreesOnStartup (default true) + manual command better-git-vscode.collapse-worktrees.
**Commit:** pending-on-branch-feat/collapse-worktrees-on-startup
**Guard:** Command id verified against the shipped VS Code bundle (workbench.desktop.main.js: id 'workbench.scm.action.collapseAllRepositories', runInView -> collapseAllRepositories() iterating visibleRepositories). Thorough comments in extension.ts above activate() document both caveats (reveal-required view action + async populate). No unit test (needs a live VS Code host + multiple worktrees — Mini verifies).
---

---
**Date:** 2026-07-03T00:46:34Z
**Trigger:** Ethan voice 2026-07-03 'glitchy as fuck... worked once and now it's just not going to next change' + follow-ups (5-line jump on modified files, deleted file does nothing)
**Symptom:** v1.2.0 'scroll through newly-added files' glitchy: next-scm-change stopped advancing (perceived no-op), 5-line jump wrongly fired on MODIFIED files, deleted files dead-ended navigation
**Root cause:** Decision/action editor mismatch: goToNextDiff decided 'new file?' from the ACTIVE TAB (currentReviewFileUri) but stepped vscode.window.activeTextEditor — the FOCUSED editor, which is a different concept. SCM single-clicks open files with preserveFocus:true, so activeTextEditor stays pointing at a stale/different file: steps landed invisibly in hidden editors (no-op) or in a modified file's editor (hunk-nav hijack). Compounders: isFullyAddedFile returned true for dual-state INDEX_ADDED+MODIFIED files and consulted repositories[0] as fallback; unfocused editors render no caret so even correct steps were invisible; getActiveChange resolved plain tabs from activeTextEditor so deleted-file (git: scheme plain tab) navigation dead-ended on stale paths
**Fix:** v1.2.1: structural gate newFileScrollEditor() — 5-line step ONLY when active tab is TabInputText (plain editor, so diffs/modified files can NEVER step) AND uri scheme is file: (excludes deleted files' git: HEAD view) AND hardened isFullyAddedFile (dual-state veto, no repo guessing, UNTRACKED/INDEX_ADDED/INTENT_TO_ADD only) AND a visible editor for that exact document exists — stepping acts on THAT editor, focused, reveal InCenter. Hunk nav reads lineBefore/After from tab-derived editor. getActiveChange resolves plain tabs tab-first. Plus real E2E suite (npm test) pinning every file state
**Commit:** pending-on-branch-fix/new-file-nav-glitch-e2e
**Guard:** E2E suite src/test/suite/navigation.test.ts: modified-file hunk-nav regression test (asserts cursor lands on hunk lines, not +5), deleted/renamed/staged-deleted exclusion tests, dual-state test, untracked stepping+edge tests
---

---
**Date:** 2026-07-03T00:02:34Z
**Trigger:** Ethan voice 2026-07-03 'jump five lines so I can scroll down the file just for newly added ones'
**Symptom:** Reviewing a newly-added file, next/previous-change (go-to-next-change) skips straight past it — can't scroll through / read the whole new file
**Root cause:** goToNextDiff/goToPreviousDiff use VS Code compareEditor.next/previousChange, which treats a fully-added file (whole file is one new diff, no original side) as a single change and jumps past it to the next file
**Fix:** Added isFullyAddedFile() (git-status detection: UNTRACKED/INDEX_ADDED/INTENT_TO_ADD via git API + toFilePathUri) + stepThroughNewFile(); goToNextDiff/goToPreviousDiff now step cursor down/up newFileNavLineJump lines (default 5) through a fully-added file, falling through to next/prev FILE at the edge. New setting better-git-vscode.newFileNavLineJump. v1.2.0
**Commit:** 5e3ea20
**Guard:** Behaviour gated strictly on whole-new-file git status so modified files navigate hunk-to-hunk unchanged; thorough inline comments
---

---
**Date:** 2026-06-29T16:33:14Z
**Trigger:** voice: show last staged file in bottom bar
**Symptom:** Stage-and-advance (shift+alt+z) jumps to the next file instantly, so the user often stages a file without noticing and has no record of what was staged to go back and undo
**Root cause:** The extension had no UI feedback for what it staged; both stage paths just called repo.add() and (for advance) immediately switched the active editor to the next file
**Fix:** Added a persistent vscode.StatusBarItem (Left, prio 100) showing the last-staged basename; all stage paths route through one stageThroughExtension(repo,uri) chokepoint that records the URI only AFTER add() resolves and BEFORE the editor advances, so the bar reflects the file actually staged, not the one jumped to. Click reopens its staged diff via getFileChanges+openChangeEntry. Gated by better-git-vscode.showLastStagedInStatusBar (default true), reacts live to config changes.
**Commit:** 433a7be
**Guard:** Single chokepoint stageThroughExtension means future stage paths can't bypass the indicator; recordLastStaged only runs on add() success; thorough comments at the chokepoint explain the capture-before-advance ordering. CHANGELOG 1.1.0 entry.
---

---
**Date:** 2026-06-23T13:35:57Z
**Trigger:** Add Dvorak mode toggle to EthanSK/better-git-vscode
**Symptom:** Dvorak users had to hand-maintain a keybindings.json override block to remap better-git-vscode nav keys (alt+v/alt+w etc) and disable the QWERTY defaults via -command minus-entries
**Root cause:** Extension only shipped QWERTY-positioned default keybindings; no built-in layout toggle, so non-QWERTY users patched it manually
**Fix:** Added boolean setting better-git-vscode.dvorakMode; each of the 4 swapped commands ships two contributes.keybindings entries gated with VS Code native config.<settingId> when-clauses. Toggle disables old + enables new in one step, no -command entries, no setContext, no restart. User keybindings still win.
**Commit:** d67704f
**Guard:** _comment_dvorakMode_keybindings block in package.json + CHANGELOG 1.0.3 document the config-when-clause pattern
---

---
**Date:** 2026-06-23T13:55:00Z
**Trigger:** voice note — Ethan ANGRY that old-name references still remained after a prior pass claimed clean
**Symptom:** After v1.0.1 "rename polish", the old extension name still appeared all over the repo: command/config ids were still in the old namespace, README still documented the old namespace + had the old badge default, package.json still had a command title with the old verb phrase, and the repo itself was still named with the old slug. A confirmation modal also interrupted cross-file navigation. The badge defaulted to a red circle instead of double fire.
**Root cause:** The PRIOR pass made a deliberate-but-wrong call to KEEP the command-id namespace (reasoning: ids are functional identifiers referenced by keybindings.json/Karabiner, renaming breaks shortcuts). Ethan explicitly reversed this — he wants ZERO old-name references anywhere, ids included, and his keybindings.json migrated to match. Karabiner only sends f-keys/chords into VS Code, which resolves them via keybindings.json, so only the command ids in keybindings.json needed migrating, NOT Karabiner itself.
**Fix:** (1) Renamed the WHOLE namespace old → `better-git-vscode.*` in package.json (contributes.commands/keybindings/configuration) and src/extension.ts (registerCommand/executeCommand/getConfiguration), and dropped the redundant `go-to-` prefix from individual command suffixes (e.g. `next-changed-file`). (2) Migrated `~/Library/Application Support/Code/User/keybindings.json` to the new ids. (3) Removed the "Jump to next file?" modal entirely — goToNextDiff/goToPreviousDiff in src/extension.ts now always call openNextFile()/openPreviousFile() silently; deleted the `promptBeforeNextFile` setting + the now-dead isNavigationPromptOpen guard + getNextFileName/getPreviousFileName helpers. (4) Changed badge default to 🔥🔥 in BOTH package.json contributes.configuration default AND the src/extension.ts getConfiguration fallback (they MUST match). (5) `gh repo rename better-git-vscode` (old URL auto-redirects), `git remote set-url origin`, updated package.json repository.url + README links; upstream credit now points at the author's profile URL (no repo slug) so the credit survives the zero-old-ref grep. Bumped 1.0.1 → 1.0.2.
**Commit:** pending (see PR)
**Guard:** The verify grep `grep -rniE "go.?to.?next.?change" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=out` MUST return zero hits — run it before claiming done. The badge default is duplicated in two places (package.json + extension.ts fallback) with a comment in each pointing at the other. CHANGELOG 1.0.2 entry documents all four changes.
---

---
**Date:** 2026-06-23T01:16:29Z  (SUPERSEDED by the 2026-06-23T13:55 entry above)
**Trigger:** voice note rename request
**Symptom:** Productizing the VS Code fork: rename to public name 'Better Git VS Code' without breaking Ethan's keyboard shortcuts
**Root cause:** Command IDs (the old `<oldslug>.*` namespace) are functional identifiers referenced by Ethan's Karabiner config + personal keybindings.json; renaming the namespace was thought to risk breaking shortcuts.
**Fix:** (REVERSED in v1.0.2.) Renamed ONLY user-facing/cosmetic text and LEFT the command-id namespace verbatim. This was wrong — Ethan wanted the ids renamed too and his keybindings.json migrated. See the v1.0.2 entry for the correct full-rename approach.
**Commit:** 7b273bd
**Guard:** superseded
---

---
**Date:** 2026-06-22T19:05:32Z  (SUPERSEDED by the 2026-06-23T13:55 entry above)
**Trigger:** productize for marketplace publish under publisher ethansk renamed better-git-vscode
**Symptom:** Productizing the fork for public Marketplace publish: rename, keybindings, original icon, vsix package
**Root cause:** Upstream identity (name/displayName/logo.png) is the upstream author's and cannot ship; needed own branding.
**Fix:** package.json name=better-git-vscode, displayName=Better Git VS Code, v1.0.0, icon=src/icon.png. (v1.0.0/1.0.1 kept the old command ids — REVERSED in v1.0.2.) New headline keys alt+. (smart-forward) / alt+, (smart-back) = QWERTY >/< keys. Original icon authored as src/icon.svg, rasterized via npx --no-save sharp (density 384) since rsvg-convert/qlmanage-SVG unavailable on this Mac. npx vsce package OK.
**Commit:** pending
**Guard:** superseded
---

---
**Date:** 2026-06-15T16:13:35Z
**Trigger:** staged-file editor-not-found 2026-06-15
**Symptom:** 'The editor could not be opened because the file was not found' when next/prev navigation lands on a STAGED file (newly-added or staged-for-deletion)
**Root cause:** openChangeEntry always built the staged diff as left=toGitUri(HEAD) right=toGitUri('') regardless of git status. The git: content provider serves a side via 'git show <ref>:<path>'; for INDEX_ADDED there is no HEAD blob and for INDEX_DELETED there is no index blob, so git errors and VS Code throws FileSystemError.FileNotFound -> that editor error.
**Fix:** Carry git status on each staged FileChange and branch in openChangeEntry: INDEX_ADDED -> empty-tree as original; INDEX_DELETED -> empty-tree as modified; everything else HEAD<->index as before. empty-tree object id (4b825dc... sha1 / 6ef19b4... sha256) is the one ref the content provider maps to empty bytes instead of throwing, mirroring VS Code's own getLeftResource/getRightResource which omit the missing side.
**Commit:** c1cb4fb
**Guard:** openChangeEntry has explicit status branches + thorough comment; CHANGELOG 0.8.1 entry
---
