<p align="center">
  <img src="src/icon.png" width="120" alt="Better Git VS Code icon" />
</p>

<h1 align="center">Better Git VS Code</h1>

<p align="center">
  <b>Fast, keyboard-driven git diff review.</b> Jump between changes and changed files,
  stage-and-advance, and revert — all without touching the mouse.
</p>

---

Review your git changes at the speed of thought — one hand on the keyboard, no mouse, no Source Control panel hunting. Three features do the heavy lifting:

### 🔥 Jump between every git change, instantly

VS Code's built-in change navigation is a clunky, click-heavy chore. **This fixes it.** One key flies you to the next (or previous) change — and when you hit the end of a file, it rolls straight into the next changed file automatically. No scrolling, no clicking through the SCM tree, no losing your place. Fly through an entire AI-generated changeset like it's nothing.

`Option+.` next · `Option+,` previous — literally the `>` / `<` keys, pointing the way.

### Hold Shift to stage as you review

Approve as you go. Holding **Shift** on the nav key stages the file you're looking at and jumps you straight to the next *unstaged* change — so reviewing and staging become one continuous flow. No reaching for the mouse, no detour to the Source Control panel. Sweep through, approving each file with a flick of the same key.

`Shift+Option+.` stage & next · `Shift+Option+,` stage & previous.

### Jump from a staged diff straight to the real file — same line

When you open a *staged* file, what you see is a frozen, read-only snapshot of what's staged — you can't actually edit it there. Spot a bug mid-review and you'd normally have to go hunt down the real file. **One key does it for you:** it opens the actual, editable working file at the *exact* line and scroll position you were looking at. See it, fix it, on the spot.

`Option+R` — open & reveal the real file *(remap to anything you like; see overrides below)*.

## Keybindings

The headline navigation keys are `Alt+.` and `Alt+,`. On a standard **QWERTY** keyboard
those are the physical `>` and `<` keys — "next" and "previous" feel obvious because
the keycaps literally point forward and back.

All bindings ship as defaults and are fully overridable (see below).

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| **Next change** (smart forward) | `Alt+.` | `Alt+.` |
| **Previous change** (smart back) | `Alt+,` | `Alt+,` |
| Next git change (within file) | `Alt+Z` | `Alt+Z` |
| Previous git change (within file) | `Alt+A` | `Alt+A` |
| Next changed file | `Cmd+Alt+.` | `Ctrl+Alt+.` |
| Previous changed file | `Cmd+Alt+,` | `Ctrl+Alt+,` |
| Stage current file + next change | `Shift+Alt+.` | `Shift+Alt+.` |
| Stage current file + previous change | `Shift+Alt+,` | `Shift+Alt+,` |
| Revert selected change and save | `Alt+Q` | `Alt+Q` |
| Reveal current file in Explorer | `Alt+R` | `Alt+R` |
| Open changes at cursor/scroll + Source Control | `Ctrl+Shift+G` | `Ctrl+Shift+G` |

> **Smart forward / back** means: if you're in a diff, move to the next/previous change
> within it; otherwise navigate forward/back through changed files. It's the one binding
> you need for most reviews.

> **`Ctrl+Shift+G`** is remapped from VS Code's stock "show Source Control" chord (which only
> opened the panel) to *also* open the current file's changes (diff) at the exact cursor and
> scroll position you were viewing first, then show Source Control. Override it like any other
> binding if you want the original behaviour back.

`Stage current file` is also available as a `+` button in the editor title bar (no key
needed).

## Dvorak mode (one toggle)

The in-file change-nav defaults (`Alt+Z` / `Alt+A`) and stage-and-advance defaults
(`Shift+Alt+.` / `Shift+Alt+,`) are positioned for **QWERTY**. On a **Dvorak** layout
those keys land under different fingers and feel awkward.

Flip the single setting **`better-git-vscode.dvorakMode`** (Settings → Better Git VS Code,
or add `"better-git-vscode.dvorakMode": true` to your `settings.json`) and the navigation
keys swap to Dvorak-comfortable physical positions:

| Action | QWERTY default | Dvorak mode |
| --- | --- | --- |
| Next git change (within file) | `Alt+Z` | `Alt+V` |
| Previous git change (within file) | `Alt+A` | `Alt+W` |
| Stage current file + next change | `Shift+Alt+.` | `Shift+Alt+V` |
| Stage current file + previous change | `Shift+Alt+,` | `Shift+Alt+W` |

When the toggle is on, the QWERTY defaults for those four commands are automatically
disabled and the Dvorak-position keys take over (it uses VS Code's native
`config.better-git-vscode.dvorakMode` when-clauses — no extension restart trick). Smart
forward/back (`Alt+.` / `Alt+,`), changed-file nav (`Cmd/Ctrl+Alt+.` / `,`), revert
(`Alt+Q`) and reveal (`Alt+R`) are **left on their defaults** in both modes.

> Your own `keybindings.json` entries always win, so you can still hand-tune any of these
> on top of the toggle (see *Overriding any keybinding* below).

## Overriding any keybinding

Every default ships from the extension and can be overridden per command. To change one,
open *Preferences: Open Keyboard Shortcuts*, search for the command (they're all under the
`better-git-vscode.*` namespace — e.g. `better-git-vscode.smart-forward`), and assign your
own key. To disable a default instead, add a rule prefixed with `-` in `keybindings.json`:

```jsonc
{ "key": "alt+.", "command": "-better-git-vscode.smart-forward" }
```

> Tip: many people prefer to map **Open & reveal current file in Explorer**
> (`better-git-vscode.reveal-current-file-in-explorer`) to something like `Shift+Cmd+E`.
> We ship the default as `Option+R` rather than `Shift+Cmd+E` because the latter is already
> a built-in VS Code shortcut — but you're free to override it to `Shift+Cmd+E` (or anything
> else) in your own `keybindings.json` if you don't mind reclaiming that combo.

## Settings

A few behaviours are configurable under **Settings → Better Git VS Code**:

- **Dvorak mode** — swap the navigation keys to Dvorak-comfortable positions with one toggle (`better-git-vscode.dvorakMode`, see the *Dvorak mode* section above).
- **Last-staged status bar** — a bottom-left `✓ Staged: <filename>` indicator showing the last file you staged through the extension, so a fast stage-and-advance never stages something without you noticing. Click it to reopen that file's staged diff and unstage it if it was a mistake. Toggle with `better-git-vscode.showLastStagedInStatusBar` (default on).
- **List vs Tree view** in Source Control (`better-git-vscode.treeView`).
- Whether the Source Control panel opens on navigation (`shouldOpenScmView`).
- The badge shown on the file you're currently reviewing (`currentFileBadge`, default 🔥🔥).
- Experimental staged-file highlighting (`revealStagedInSourceControl`).

## Credits

Better Git VS Code is a fork of the original git-diff-navigation extension by
[**Alfred Birk**](https://github.com/alfredbirk), extended with a stage-and-advance
review flow, staged-diff navigation, smart forward/back, and the QWERTY `<` / `>`
default keys. Thanks to Alfred Birk for the original extension.

## License

[MIT](LICENSE).
