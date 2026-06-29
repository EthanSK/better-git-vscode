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
