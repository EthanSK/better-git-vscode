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

### Read every line of brand-new files, too

Reviewing an AI changeset that adds whole new files? A brand-new file is one big new-diff with no per-change hunks to jump between, so change-navigation used to fly straight past it — you never actually read it. Now, on a fully-added file (untracked / staged-new), the next/previous-change keys **step the cursor a few lines at a time** so you page through and review the entire file, then roll on to the next change as usual. Tune the step with `better-git-vscode.newFileNavLineJump` (default 5). Modified files are never affected — they always navigate change-to-change.

## Tidy worktrees: auto-collapse the extras, keep your main repo open

If you work with **git worktrees** (or several repos in one window), VS Code's Source Control panel shows each as its own collapsible section and renders them **all expanded** on every window open / reload — noisy once you have a few. This extension folds them for you shortly after the window loads, so the panel stays tidy.

**Your primary / main repository stays expanded.** Only the *other* worktrees collapse — the repo at the top (your main working copy, the one you're actually working in) is left open. It's detected as the repository matching your first workspace folder; linked worktrees (which live elsewhere on disk) are the ones that fold.

- **Setting `better-git-vscode.collapseWorktreesOnStartup`** (boolean, default **on**) toggles the whole behaviour. It only acts when there are 2+ repositories open. Turn it off to leave the sections however VS Code renders them.
- **Command `Better Git: Collapse all worktree / repository sections in Source Control`** (`better-git-vscode.collapse-worktrees`) folds them on demand from the Command Palette any time they've crept back open — also keeping the primary expanded. Bind it to a key if you like.

> **How it works, and its honest limits.** VS Code has no API to collapse/expand a *single* repository (its built-ins collapse or expand them all at once), and no way to persist the collapsed state. So the extension collapses everything, then re-expands just the primary by leveraging VS Code's own `scm.autoReveal`. Consequences: it relies on `scm.autoReveal` being on (VS Code default) — with it off, the primary collapses too; re-expanding opens one of the primary repo's changed files in a *preview tab*; and if the primary has no changes there's nothing to re-expand toward. It's a best-effort workaround for the missing native "remember collapsed state", timing-dependent by nature, and it briefly focuses the Source Control panel when it fires.

## Keybindings

The headline navigation keys are `Alt+.` and `Alt+,`. On a standard **QWERTY** keyboard
those are the physical `>` and `<` keys — "next" and "previous" feel obvious because
the keycaps literally point forward and back.

All bindings ship as defaults and are fully overridable (see below).

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| **Next change** | `Alt+.` | `Alt+.` |
| **Previous change** | `Alt+,` | `Alt+,` |
| Next changed file | `Cmd+Alt+.` | `Ctrl+Alt+.` |
| Previous changed file | `Cmd+Alt+,` | `Ctrl+Alt+,` |
| Stage current file + next change | `Shift+Alt+.` | `Shift+Alt+.` |
| Stage current file + previous change | `Shift+Alt+,` | `Shift+Alt+,` |
| Revert selected change and save | `Alt+Q` | `Alt+Q` |
| Reveal current file in Explorer | `Alt+R` | `Alt+R` |
| Open changes at cursor/scroll + Source Control | `Ctrl+Shift+G` | `Ctrl+Shift+G` |

> **Next / previous change** walks hunk-to-hunk through the current diff, pages through
> brand-new files a few lines at a time, and rolls over to the next/previous changed file
> at either end. It's the one pair of keys you need for most reviews. (Before v1.2.5 these
> keys pointed at the *smart forward/back* mouse commands, whose in-diff direction is
> deliberately reversed for mouse thumb-buttons — which made keyboard `>` / `<` navigate
> backwards on QWERTY. Fixed: they now run the real change-navigation commands.)

> **Smart forward / back** (`better-git-vscode.smart-forward` / `.smart-back`) are
> **mouse-button commands** with no default keyboard key: in a diff they go to the
> previous/next change (direction intentionally reversed for thumb-buttons), elsewhere
> they do normal editor back/forward. Bind them to your mouse's Forward/Back buttons
> (e.g. via Karabiner → F13/F17 → `keybindings.json`).

> **`Ctrl+Shift+G`** is remapped from VS Code's stock "show Source Control" chord (which only
> opened the panel) to *also* open the current file's changes (diff) at the exact cursor and
> scroll position you were viewing first, then show Source Control. Override it like any other
> binding if you want the original behaviour back.

`Stage current file` is also available as a `+` button in the editor title bar (no key
needed).

## Dvorak mode (one toggle)

The change-nav defaults live on the **physical `>` and `<` keys**. On QWERTY those keys
type `.` and `,`; on **Dvorak** the *same physical keys* type `v` and `w`, so the QWERTY
character bindings would land under the wrong fingers.

Flip the single setting **`better-git-vscode.dvorakMode`** (Settings → Better Git VS Code,
or add `"better-git-vscode.dvorakMode": true` to your `settings.json`) and the bindings
swap to the Dvorak characters for the *same physical keys* — same commands, same
behaviour, same finger positions, different keycap labels. Dvorak mode is a thin key
remap over the one canonical navigation behaviour; it never changes what the commands do:

| Action (physical key) | QWERTY default | Dvorak mode |
| --- | --- | --- |
| Next change (`>` key) | `Alt+.` | `Alt+V` |
| Previous change (`<` key) | `Alt+,` | `Alt+W` |
| Stage current file + next change (`Shift+>`) | `Shift+Alt+.` | `Shift+Alt+V` |
| Stage current file + previous change (`Shift+<`) | `Shift+Alt+,` | `Shift+Alt+W` |

When the toggle is on, the QWERTY defaults for those four commands are automatically
disabled and the Dvorak-character keys take over (it uses VS Code's native
`config.better-git-vscode.dvorakMode` when-clauses — no extension restart trick).
Changed-file nav (`Cmd/Ctrl+Alt+.` / `,`), revert (`Alt+Q`) and reveal (`Alt+R`) are
**left on their defaults** in both modes. In Dvorak mode the freed-up `Alt+.` / `Alt+,`
characters additionally map to the smart forward/back mouse commands (they sit on
different physical keys there, so nothing collides).

> Your own `keybindings.json` entries always win, so you can still hand-tune any of these
> on top of the toggle (see *Overriding any keybinding* below).

## Overriding any keybinding

Every default ships from the extension and can be overridden per command. To change one,
open *Preferences: Open Keyboard Shortcuts*, search for the command (they're all under the
`better-git-vscode.*` namespace — e.g. `better-git-vscode.smart-forward`), and assign your
own key. To disable a default instead, add a rule prefixed with `-` in `keybindings.json`:

```jsonc
{ "key": "alt+.", "command": "-better-git-vscode.next-scm-change" }
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
- **Auto-collapse extra worktrees** — fold the other worktree/repository sections on window open while keeping your main repo expanded (`better-git-vscode.collapseWorktreesOnStartup`, default on — see *Tidy worktrees* above).
- **New-file line step** — how many lines the change keys step through a brand-new file (`better-git-vscode.newFileNavLineJump`, default 5).
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
