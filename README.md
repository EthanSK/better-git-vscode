<p align="center">
  <img src="src/icon.png" width="120" alt="Better Git VS Code icon" />
</p>

<h1 align="center">Better Git VS Code</h1>

<p align="center">
  <b>Fast, keyboard-driven Git review for the agentic age.</b>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=EthanSK.better-git-vscode"><b>Install from the VS Code Marketplace</b></a>
  ·
  <a href="https://github.com/EthanSK/better-git-vscode">GitHub</a>
</p>

---

AI can write a changeset in seconds. You still need to review every line. Better Git VS Code turns that review into one continuous loop inside VS Code: move through each change, inspect it in context, stage the file when it is right, and keep going without reaching for the mouse or hunting through Source Control.

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

Reviewing an AI changeset that adds whole new files? A brand-new file is one big new-diff with no per-change hunks to jump between, so change-navigation used to fly straight past it — you never actually read it. Now, on a fully-added file (untracked / staged-new), the next/previous-change keys **step the cursor a few lines at a time** so you page through and review the entire file, then roll on to the next change as usual. Tune the step with `better-git-vscode.newFileNavLineJump` (default 5). Modified files are never affected — they always navigate change-to-change.

### Step through tall hunks in stages — no more reaching for the scrollbar

Some hunks **run below the visible screen.** One press of next-change can land near the bottom — and the rest runs off-screen, so you'd have to take your hands off the keyboard, scroll, then press next again. Large replacements are especially awkward because Git and VS Code can divide the same visual change differently: native navigation may leap dozens of lines or move to the next file while the broader replacement still has unread content. Better Git retains that broader hunk boundary and steps through it before accepting an oversized jump or rollover.

Hunks whose complete rendered range is already visible are untouched — one press still jumps straight to the next/previous hunk. Anything unread moves by exactly five logical lines per press by default; the final partial step lands on and presents the exact hunk edge, and only the following press may leave it. `previous-change` mirrors the same contract, including direction reversal from the current caret. Set `better-git-vscode.hunkStagingLineStep` to any positive custom step, or `0` for viewport-minus-overlap auto mode. Tune the engage threshold with `hunkStagingThreshold`, the auto-mode overlap with `hunkStagingOverlap`, or turn the feature off with `hunkStagingEnabled`.

For the exact boundary rules and the engineering behind the navigation fix, see [How Better Git VS Code navigation works](docs/navigation-behavior.md).

## Source Control show/hide automation is experimental and off by default

VS Code saves Source Control tree data per workspace, but current releases can still rebuild repository and change-group sections expanded after a restart. VS Code exposes no reliable extension API for reading or setting one particular repository or group node. Better Git's earlier attempt to reconstruct that mixed state by walking generic list rows became visibly repetitive with many worktrees, so v1.2.31 withdraws that implementation.

- **Default:** pure VS Code behavior. Better Git does not read Source Control tree storage, start a discovery timer, reveal or focus Source Control, select or walk rows, or expand/collapse anything during startup.
- **Experimental automatic-behavior switch:** `better-git-vscode.experimentalScmTreeStateManagement` is off by default. Turning it on permits the optional startup behavior below, but does not itself perform any startup action.
- **Manual command:** `Better Git: Collapse all worktree / repository sections in Source Control` (`better-git-vscode.collapse-worktrees`) is always available in the Command Palette and invokes VS Code's built-in all-repositories collapse once. It does not require either automatic setting.
- **Optional startup collapse:** also turn on `better-git-vscode.collapseWorktreesOnStartup` to run that same built-in collapse once after 2+ repositories finish discovery. There are no retries and no row traversal.

Exact mixed-state restoration remains paused until VS Code provides a dependable per-node contract that can be tested without selecting rows or accidentally targeting another Source Control list such as Source Control Graph.

## Pull a worktree into your sidebar without leaving the editor

Reviewing a file that lives in another git **worktree** and want it in your workspace? Run **`Better Git: Add current file's git worktree to workspace`** (`better-git-vscode.add-current-worktree-to-workspace`) from the Command Palette. It finds the worktree the current (or under-review) file belongs to and adds that worktree's root as a workspace folder, so it shows up in your Explorer / Source Control sidebar.

The **`Open & Reveal File in Explorer`** command (`better-git-vscode.reveal-current-file-in-explorer`, `Option+R` by default) now does this automatically when needed. If the current diff/file belongs to a worktree that Source Control knows about but Explorer does not contain, one press opens the real editable file, adds that worktree root, waits for Explorer to register it, and reveals the file there. The explicit add-worktree command remains useful when you want to add the root without switching away from the diff. Turn off **Auto-add worktree on reveal** (`better-git-vscode.autoAddWorktreeOnReveal`) if you prefer reveal to open the file without changing workspace folders; it is on by default.

- Works from a diff, a plain editor, or while focus is in the Source Control panel — it uses the same "file under review" detection as the navigation commands.
- If the file isn't inside any git repository, it just tells you so (no error). If the worktree is already a workspace folder, it says so and does nothing.
- **Note:** if your window currently has a single folder open, adding the first extra folder turns it into a *multi-root* workspace, which triggers a quick window reload (VS Code restarts the extension host on that transition). Better Git VS Code warns you; the explicit add command performs the add as its very last step, while reveal opens the editable file first so it survives the restart and auto-reveals afterward.

## Useful right-click actions

- Right-click a local **`index.html`** in Explorer and choose **Open index.html in System Browser**, or use the same action on a changed `index.html` row in Source Control, to open that exact report/page in your default browser. VS Code does not expose filenames to SCM menu `when` clauses, so the Source Control action is visible on other Git rows too; its runtime guard refuses anything except a local `index.html`.
- Right-click any changed Source Control file and choose **Open & Reveal File in Explorer** to add its worktree when needed and reveal that exact row, even when another editor was active.
- Right-click a linked **worktree header** and choose **Add Worktree to Workspace** to append it to the current Explorer without replacing your existing workspace folders. **Copy Worktree Name** remains immediately above it.

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

> Tip: many people prefer to map **Open & Reveal File in Explorer**
> (`better-git-vscode.reveal-current-file-in-explorer`) to something like `Shift+Cmd+E`.
> We ship the default as `Option+R` rather than `Shift+Cmd+E` because the latter is already
> a built-in VS Code shortcut — but you're free to override it to `Shift+Cmd+E` (or anything
> else) in your own `keybindings.json` if you don't mind reclaiming that combo. Bind the Better Git
> command unconditionally; `isInDiffEditor` becomes false while Source Control owns keyboard focus even if a
> diff remains visibly active, which would otherwise send the key to VS Code's built-in non-worktree-aware reveal.

## Settings

A few behaviours are configurable under **Settings → Better Git VS Code**:

- **Dvorak mode** — swap the navigation keys to Dvorak-comfortable positions with one toggle (`better-git-vscode.dvorakMode`, see the *Dvorak mode* section above).
- **Last-staged status bar** — a bottom-left `✓ Staged: <filename>` indicator showing the last file you staged through the extension, so a fast stage-and-advance never stages something without you noticing. Click it to reopen that file's staged diff and unstage it if it was a mistake. Toggle with `better-git-vscode.showLastStagedInStatusBar` (default on).
- **Experimental Source Control automation** — automatic tree manipulation is off by default behind `better-git-vscode.experimentalScmTreeStateManagement`. The manual Command Palette collapse remains available; the separate `collapseWorktreesOnStartup` double opt-in runs one built-in collapse with no retries. Exact mixed-state restoration is paused. See *Source Control show/hide automation is experimental and off by default* above.
- **Auto-add worktree on reveal** — when reveal targets a worktree outside Explorer, add that worktree root as a workspace folder and reveal the file (`better-git-vscode.autoAddWorktreeOnReveal`, on by default; see *Pull a worktree into your sidebar* above).
- **New-file line step** — how many lines the change keys step through a brand-new file (`better-git-vscode.newFileNavLineJump`, default 5).
- **Tall-hunk staging** — present or step through any hunk whose complete rendered range is not on-screen, instead of letting unread lines run off the bottom (`better-git-vscode.hunkStagingEnabled`, default on — see *Step through tall hunks in stages* above). Tune the engage threshold (`hunkStagingThreshold`, 0 = auto/rendered visibility), the exact per-step move (`hunkStagingLineStep`, default 5; any positive custom value; 0 = viewport-minus-overlap auto mode), and the overlap used by auto mode (`hunkStagingOverlap`, default 4).
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
