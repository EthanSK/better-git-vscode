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

### Step through tall hunks in stages — no more reaching for the scrollbar

Some hunks are **taller than your screen.** One press of next-change lands you at the *top* — and the rest runs off the bottom, so you'd have to take your hands off the keyboard, scroll, then press next again. Now the **same key steps through it in stages:** next-change lands at the top; press next **again** and it scrolls down about a screenful *within that same hunk*; keep going until the bottom is on screen, then the next press moves on to the next hunk. `previous-change` mirrors it — stepping **up** through a tall hunk, then on to the previous one once the top is visible. Reverse direction any time and it steps back the other way instead of teleporting.

Hunks that already fit on screen are untouched — one press still jumps straight to the next/previous hunk. Staging kicks in **only when a hunk is taller than your visible editor** (measured live, so it adapts to your window size), and each step keeps a few lines of overlap so you never lose your place. Tune it with `better-git-vscode.hunkStagingThreshold`, `hunkStagingLineStep`, and `hunkStagingOverlap`, or turn it off with `hunkStagingEnabled`.

## Tidy worktrees: auto-collapse the extras, keep your main repo open

If you work with **git worktrees** (or several repos in one window), VS Code's Source Control panel shows each as its own collapsible section and renders them **all expanded** on every window open / reload — noisy once you have a few. This extension folds them for you shortly after the window loads, so the panel stays tidy.

**Your primary / main repository stays expanded.** Only the *other* worktrees collapse — the repo at the top (your main working copy, the one you're actually working in) is left open. It's detected as the repository matching your first workspace folder; linked worktrees (which live elsewhere on disk) are the ones that fold.

- **Setting `better-git-vscode.collapseWorktreesOnStartup`** (boolean, **off by default; turn on to enable**) toggles the whole behaviour. It only acts when there are 2+ repositories open. Leave it off to have VS Code render the sections however it likes; turn it on to auto-collapse the other worktrees on startup. The manual command below works either way.
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

The **`+` button in the editor title bar** now **stages the current file _and_ advances** to the
next change — in whatever direction you last navigated. Jump forward through changes (`>` / `Alt+.`)
and the `+` advances forward; jump backward (`<` / `Alt+,`) and it advances backward. So you can run
the whole review-and-stage flow with the mouse alone — click `+` to stage-and-jump instead of
clicking `+` then reaching for the keyboard. It calls the exact same logic as the `Shift+Alt+.` /
`Shift+Alt+,` keyboard shortcuts (same staging, same advance target, same cross-file rollover). A
fresh session with no navigation yet defaults to advancing *forward*. The plain, no-advance
`Stage current file` command is still registered if you'd rather bind that to a key.

## Mouse-driven review (recommended setup)

You can drive the **entire** review-and-stage flow from your mouse — no keyboard at all. The trick
is a two-hop mapping: **Karabiner-Elements** remaps your mouse's extra buttons to spare F-keys, and
then VS Code's `keybindings.json` maps those F-keys to this extension's commands. This is the exact
setup the author uses.

**The four commands you bind:**

| Mouse button | → F-key | → Command | What it does |
| --- | --- | --- | --- |
| **Back** (thumb rear) | `F13` | `better-git-vscode.smart-back` | In a review view: **next** change. Elsewhere: browser Back. |
| **Forward** (thumb front) | `F17` | `better-git-vscode.smart-forward` | In a review view: **previous** change. Elsewhere: browser Forward. |
| (extra button) | `F18` | `better-git-vscode.stage-and-next-changed-file` | Stage current file **+ next** change. |
| (extra button) | `F19` | `better-git-vscode.stage-and-previous-changed-file` | Stage current file **+ previous** change. |

**Why the "smart" commands are dual-mode.** `smart-back` / `smart-forward` detect whether you're in a
diff/review view (a diff, a brand-new/untracked file, a deleted file, a merge-conflict editor, or a
binary/image change). **In a review view they navigate changes; anywhere else they behave as ordinary
editor Back/Forward** — so the same physical thumb buttons keep their normal browsing meaning when
you're not reviewing, and become change-navigation the moment you're looking at a diff. (The in-diff
direction is intentionally *flipped* for thumb buttons — Back goes to the **next** change, Forward to
the **previous** — because that's what feels natural pressing them; see the note below.)

**Everything behaves identically to the keyboard**, because the mouse buttons call the *exact same
functions* the keyboard shortcuts do — no separate mouse code path. That means you get, for free:
the end-of-list guards (roll over to the next/previous changed file at either end, and don't strand
you on the last file), the few-lines-at-a-time scroll through brand-new files, and the tall-hunk
staged stepping. The editor-title-bar **`+` button** also stages-and-advances in your last-navigated
direction, so a click there is the mouse equivalent of `F18`/`F19`.

### 1. Karabiner: map the mouse buttons to F-keys

In **Karabiner-Elements → Devices** (or a `Complex Modification`), send `F13`, `F17`, `F18`, `F19`
from your mouse's buttons. F13 and F16–F19 have no default macOS action, so they pass straight through
to VS Code.

> **Avoid `F14` / `F15`.** On macOS those are the **brightness down / up** keys — the OS swallows them
> before VS Code ever sees them, so a binding on `F14` silently does nothing. Stick to `F13` and
> `F16`–`F19`.

### 2. VS Code: map the F-keys to the commands

Add these to your `keybindings.json` (**Preferences: Open Keyboard Shortcuts (JSON)**). They're
unconditional — the diff-vs-not decision is baked *into* the smart commands, so there's no `when`
clause to get wrong:

```jsonc
[
  // Mouse BACK button  (Karabiner sends F13) -> smart-back:    next change while reviewing, else browser Back
  { "key": "f13", "command": "better-git-vscode.smart-back" },
  // Mouse FORWARD button (Karabiner sends F17) -> smart-forward: previous change while reviewing, else Forward
  { "key": "f17", "command": "better-git-vscode.smart-forward" },
  // Extra mouse buttons (Karabiner sends F18 / F19) -> stage-and-advance in each direction
  { "key": "f18", "command": "better-git-vscode.stage-and-next-changed-file" },
  { "key": "f19", "command": "better-git-vscode.stage-and-previous-changed-file" }
]
```

That's it — thumb-Back/Forward to fly through changes, the two extra buttons (or the title-bar `+`)
to stage-and-advance, all without touching the keyboard.

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
- **Auto-collapse extra worktrees** — fold the other worktree/repository sections on window open while keeping your main repo expanded (`better-git-vscode.collapseWorktreesOnStartup`, off by default — turn on to enable; see *Tidy worktrees* above).
- **New-file line step** — how many lines the change keys step through a brand-new file (`better-git-vscode.newFileNavLineJump`, default 5).
- **Tall-hunk staging** — step through a hunk taller than your screen in stages with the same next/previous keys, instead of the rest running off the bottom (`better-git-vscode.hunkStagingEnabled`, default on — see *Step through tall hunks in stages* above). Tune the engage threshold (`hunkStagingThreshold`, 0 = auto/viewport), the per-step scroll (`hunkStagingLineStep`, 0 = auto), and the overlap kept between steps (`hunkStagingOverlap`, default 4).
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
