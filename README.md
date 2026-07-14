<p align="center">
  <img src="src/icon.png" width="120" alt="Agentic Git icon" />
</p>

<h1 align="center">Agentic Git</h1>

<p align="center">
  <b>Fast, keyboard-driven Git review for the agentic age.</b>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=EthanSK.agentic-git"><b>Install from the VS Code Marketplace</b></a>
  ·
  <a href="https://github.com/EthanSK/agentic-git">GitHub</a>
</p>

---

AI can write a changeset in seconds. You still need to review every line. Agentic Git turns that review into one continuous loop inside VS Code: move through each change, inspect it in context, stage the file when it is right, and keep going without reaching for the mouse or hunting through Source Control.

## The review loop

### 1. Jump between every Git change

One key flies to the next or previous change. At the end of a file, it continues into the next changed file automatically. No scrolling, clicking through the SCM tree, or losing your place in a large AI-generated changeset.

`Option+.` next · `Option+,` previous — literally the `>` / `<` keys, pointing the way.

### 2. Hold Shift to stage and continue

Approve as you go. Holding **Shift** on the nav key stages the file you're looking at and jumps you straight to the next *unstaged* change — so reviewing and staging become one continuous flow. No reaching for the mouse, no detour to the Source Control panel. Sweep through, approving each file with a flick of the same key.

`Shift+Option+.` stage & next · `Shift+Option+,` stage & previous.

### 3. Fix something without losing your place

When you open a *staged* file, what you see is a frozen, read-only snapshot of what's staged — you can't actually edit it there. Spot a bug mid-review and you'd normally have to go hunt down the real file. **One key does it for you:** it opens the actual, editable working file at the *exact* line and scroll position you were looking at. See it, fix it, on the spot.

`Option+R` — open & reveal the real file *(remap to anything you like; see overrides below)*.

That is the core workflow. The same navigation keys also handle the awkward cases that ordinary hunk navigation skips: brand-new files and changes larger than the editor viewport.

## Review edge cases without leaving the keyboard

### Read every line of brand-new files

Reviewing an AI changeset that adds whole new files? A brand-new file is one big new-diff with no per-change hunks to jump between, so change-navigation used to fly straight past it — you never actually read it. Now, on a fully-added file (untracked / staged-new), the next/previous-change keys **step the cursor a few lines at a time** so you page through and review the entire file, then roll on to the next change as usual. Tune the step with `agentic-git.newFileNavLineJump` (default 5). Modified files are never affected — they always navigate change-to-change.

### Step through tall hunks in stages — no more reaching for the scrollbar

Some hunks are **taller than your screen.** One press of next-change lands you at the *top* — and the rest runs off the bottom, so you'd have to take your hands off the keyboard, scroll, then press next again. Now the **same key steps through it in stages:** next-change lands at the top; press next **again** and it scrolls down about a screenful *within that same hunk*. The final partial step always lands on and presents the exact hunk end (including the last visual segment of a wrapped line); only the following press moves on. `previous-change` mirrors it at the hunk start. Reverse direction any time and it continues from the current caret instead of teleporting.

Hunks that already fit on screen are untouched — one press still jumps straight to the next/previous hunk. Staging kicks in **only when a hunk is taller than your visible editor** (measured live, so it adapts to your window size), and each step keeps a few lines of overlap so you never lose your place. Tune it with `agentic-git.hunkStagingThreshold`, `hunkStagingLineStep`, and `hunkStagingOverlap`, or turn it off with `hunkStagingEnabled`.

For the exact boundary rules and the engineering behind the navigation fix, see [How Agentic Git navigation works](docs/navigation-behavior.md).

## Tidy worktrees after reloads and extension restarts

If you work with **git worktrees** (or several repos in one window), VS Code's Source Control panel can bring every repository section back **expanded** after a window reload or extension-host restart. Agentic Git folds all of those repository headers shortly after the repositories populate, so the panel returns to a compact state.

- **Setting `agentic-git.collapseWorktreesOnStartup`** (boolean, **on by default**) toggles the behavior. It only acts when there are 2+ repositories open. Turn it off if you want VS Code to control the sections without intervention.
- **Command `Agentic Git: Collapse all worktree / repository sections in Source Control`** (`agentic-git.collapse-worktrees`) runs the same plain collapse on demand whenever the sections have crept back open.

> **How it works, and its honest limit.** VS Code has no public API to remember or set each repository header's expansion state. Its available view action collapses all repositories and only works while Source Control is active, so Agentic Git briefly opens/focuses that view and runs the action after repository discovery (with a few bounded repeats to beat restart rendering races). It does not open or replace an editor tab.

## Pull a worktree into your sidebar without leaving the editor

Reviewing a file that lives in another git **worktree** and want it in your workspace? Run **`Agentic Git: Add current file's git worktree to workspace`** (`agentic-git.add-current-worktree-to-workspace`) from the Command Palette. It finds the worktree the current (or under-review) file belongs to and adds that worktree's root as a workspace folder, so it shows up in your Explorer / Source Control sidebar.

The **`Open & reveal current file in Explorer`** command (`agentic-git.reveal-current-file-in-explorer`, `Option+R` by default) now does this automatically when needed. If the current diff/file belongs to a worktree that Source Control knows about but Explorer does not contain, one press opens the real editable file, adds that worktree root, waits for Explorer to register it, and reveals the file there. The explicit add-worktree command remains useful when you want to add the root without switching away from the diff. Turn off **Auto-add worktree on reveal** (`agentic-git.autoAddWorktreeOnReveal`) if you prefer reveal to open the file without changing workspace folders; it is on by default.

- Works from a diff, a plain editor, or while focus is in the Source Control panel — it uses the same "file under review" detection as the navigation commands.
- If the file isn't inside any git repository, it just tells you so (no error). If the worktree is already a workspace folder, it says so and does nothing.
- **Note:** if your window currently has a single folder open, adding the first extra folder turns it into a *multi-root* workspace, which triggers a quick window reload (VS Code restarts the extension host on that transition). Agentic Git warns you; the explicit add command performs the add as its very last step, while reveal opens the editable file first so it survives the restart and auto-reveals afterward.

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

> **Smart forward / back** (`agentic-git.smart-forward` / `.smart-back`) are
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
| **Back** (thumb rear) | `F13` | `agentic-git.smart-back` | In a review view: **next** change. Elsewhere: browser Back. |
| **Forward** (thumb front) | `F17` | `agentic-git.smart-forward` | In a review view: **previous** change. Elsewhere: browser Forward. |
| (extra button) | `F18` | `agentic-git.stage-and-next-changed-file` | Stage current file **+ next** change. |
| (extra button) | `F19` | `agentic-git.stage-and-previous-changed-file` | Stage current file **+ previous** change. |

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
  { "key": "f13", "command": "agentic-git.smart-back" },
  // Mouse FORWARD button (Karabiner sends F17) -> smart-forward: previous change while reviewing, else Forward
  { "key": "f17", "command": "agentic-git.smart-forward" },
  // Extra mouse buttons (Karabiner sends F18 / F19) -> stage-and-advance in each direction
  { "key": "f18", "command": "agentic-git.stage-and-next-changed-file" },
  { "key": "f19", "command": "agentic-git.stage-and-previous-changed-file" }
]
```

That's it — thumb-Back/Forward to fly through changes, the two extra buttons (or the title-bar `+`)
to stage-and-advance, all without touching the keyboard.

## Dvorak mode (one toggle)

The change-nav defaults live on the **physical `>` and `<` keys**. On QWERTY those keys
type `.` and `,`; on **Dvorak** the *same physical keys* type `v` and `w`, so the QWERTY
character bindings would land under the wrong fingers.

Flip the single setting **`agentic-git.dvorakMode`** (Settings → Agentic Git,
or add `"agentic-git.dvorakMode": true` to your `settings.json`) and the bindings
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
`config.agentic-git.dvorakMode` when-clauses — no extension restart trick).
Changed-file nav (`Cmd/Ctrl+Alt+.` / `,`), revert (`Alt+Q`) and reveal (`Alt+R`) are
**left on their defaults** in both modes. In Dvorak mode the freed-up `Alt+.` / `Alt+,`
characters additionally map to the smart forward/back mouse commands (they sit on
different physical keys there, so nothing collides).

> Your own `keybindings.json` entries always win, so you can still hand-tune any of these
> on top of the toggle (see *Overriding any keybinding* below).

## Overriding any keybinding

Every default ships from the extension and can be overridden per command. To change one,
open *Preferences: Open Keyboard Shortcuts*, search for the command (they're all under the
`agentic-git.*` namespace — e.g. `agentic-git.smart-forward`), and assign your
own key. To disable a default instead, add a rule prefixed with `-` in `keybindings.json`:

```jsonc
{ "key": "alt+.", "command": "-agentic-git.next-scm-change" }
```

> Tip: many people prefer to map **Open & reveal current file in Explorer**
> (`agentic-git.reveal-current-file-in-explorer`) to something like `Shift+Cmd+E`.
> We ship the default as `Option+R` rather than `Shift+Cmd+E` because the latter is already
> a built-in VS Code shortcut — but you're free to override it to `Shift+Cmd+E` (or anything
> else) in your own `keybindings.json` if you don't mind reclaiming that combo.

## Settings

A few behaviours are configurable under **Settings → Agentic Git**:

- **Dvorak mode** — swap the navigation keys to Dvorak-comfortable positions with one toggle (`agentic-git.dvorakMode`, see the *Dvorak mode* section above).
- **Last-staged status bar** — a bottom-left `✓ Staged: <filename>` indicator showing the last file you staged through the extension, so a fast stage-and-advance never stages something without you noticing. Click it to reopen that file's staged diff and unstage it if it was a mistake. Toggle with `agentic-git.showLastStagedInStatusBar` (default on).
- **Auto-collapse worktrees** — fold all repository sections after window open or an extension-host restart (`agentic-git.collapseWorktreesOnStartup`, on by default; see *Tidy worktrees* above).
- **Auto-add worktree on reveal** — when reveal targets a worktree outside Explorer, add that worktree root as a workspace folder and reveal the file (`agentic-git.autoAddWorktreeOnReveal`, on by default; see *Pull a worktree into your sidebar* above).
- **New-file line step** — how many lines the change keys step through a brand-new file (`agentic-git.newFileNavLineJump`, default 5).
- **Tall-hunk staging** — step through a hunk taller than your screen in stages with the same next/previous keys, instead of the rest running off the bottom (`agentic-git.hunkStagingEnabled`, default on — see *Step through tall hunks in stages* above). Tune the engage threshold (`hunkStagingThreshold`, 0 = auto/viewport), the per-step scroll (`hunkStagingLineStep`, 0 = auto), and the overlap kept between steps (`hunkStagingOverlap`, default 4).
- **List vs Tree view** in Source Control (`agentic-git.treeView`).
- Whether the Source Control panel opens on navigation (`shouldOpenScmView`).
- The badge shown on the file you're currently reviewing (`currentFileBadge`, default 🔥🔥).
- Experimental staged-file highlighting (`revealStagedInSourceControl`).

## Credits

Agentic Git is a fork of the original git-diff-navigation extension by
[**Alfred Birk**](https://github.com/alfredbirk), extended with a stage-and-advance
review flow, staged-diff navigation, smart forward/back, and the QWERTY `<` / `>`
default keys. Thanks to Alfred Birk for the original extension.

## License

[MIT](LICENSE).
