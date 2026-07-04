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
**Date:** 2026-07-04T16:24:01Z
**Trigger:** Ethan voice/message 2026-07: '> and < next and prev are fukt on qwerty ... did u just patch the dvorak one?? ... the extra dvorak mode should be a thin wrapper on top of actual working behaviour, not redefining the functionality.'
**Symptom:** better-git-vscode: next/previous SCM change (the headline > and < keys, alt+. / alt+,) were BROKEN on QWERTY — > navigated BACKWARD through diff changes, < navigated FORWARD, and outside a diff they did editor history navigation instead of change navigation. Dvorak layout was PERFECT (source of truth).
**Root cause:** The QWERTY physical >/< keys (alt+./alt+,) were bound to smart-forward/smart-back — the MOUSE-button commands (Karabiner F13/F17) whose in-diff direction was INTENTIONALLY REVERSED for thumb-buttons in commit 6043d05 (v0.8.3, 'the diff one should be flipped, I know it's weird'). The keyboard keys silently inherited that mouse flip. Dvorak was immune because its physical >/< keys type v/w, bound alt+v/alt+w straight to the canonical next-scm-change/previous-scm-change commands. So the working Dvorak path was never touched by the mouse flip — it was the correct reference all along.
**Fix:** package.json contributes.keybindings: bound QWERTY alt+. -> next-scm-change and alt+, -> previous-scm-change (gated !config.better-git-vscode.dvorakMode), i.e. the SAME canonical commands Dvorak's alt+v/alt+w run — one behaviour, defined once, Dvorak is now purely a character-remap of the same physical keys (thin wrapper, not a fork). Dropped legacy QWERTY alt+z/alt+a defaults (alt+z shadowed VS Code built-in Toggle Word Wrap). smart-forward/smart-back are mouse-only now: NO default QWERTY keyboard binding; they keep alt+./alt+, ONLY under dvorakMode (those chars sit on different physical keys there) so the Dvorak setup is byte-identical to v1.2.4 (verified by simulating both when-clause states). Dvorak bindings/behaviour completely unchanged.
**Commit:** pending-PR
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
