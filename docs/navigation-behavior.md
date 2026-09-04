# How Better Git VS Code navigation works

Better Git VS Code treats change review as one continuous, reversible sequence. The same Next and Previous commands must behave predictably in ordinary diffs, tall hunks, brand-new files, staged files, and cross-file transitions.

## The navigation contract

The current caret is the review position. Every press starts from that position; the viewport is used only to present it. Better Git VS Code does not keep a separate forward/backward state machine that can drift away from what the user is reading.

An unresolved file opened from Source Control as a plain editor follows that same sequence. Better Git VS Code parses complete standard conflict-marker groups and treats each `<<<<<<<` / `=======` / `>>>>>>>` group as one change. Next selects the following block; Previous selects the preceding block. The blocks do not wrap inside the file: exhausting an edge rolls into the adjacent changed file, with forward navigation landing on its first block and backward navigation landing on its last. Git's live `mergeChanges` state and the active tab's exact visible editor form the gate, so marker-like text in an ordinary file and a stale focused editor cannot enter this mode.

For a brand-new file, Next and Previous move by the configured logical-line step (five lines by default):

1. Compute `caret ± step`.
2. Clamp the target to line 1 or the final line.
3. Move the caret once and reveal that exact target in the same editor.
4. If the remaining distance is smaller than a full step, consume that partial step and visibly present the edge.
5. Only a later press, made while the caret is already at the presented edge, may move to another file.

Tall diff hunks follow the same rule at hunk boundaries, with an exact ten-line step by default. Any positive custom value is also exact; setting the step to zero selects viewport-minus-overlap auto mode. Engagement tests the exact first and final rendered positions rather than comparing logical line counts: a hunk stranded near the bottom is lifted into view even when its total line count is smaller than the viewport's, while a hunk whose complete rendered range is already visible remains normal hunk-to-hunk navigation. Its exact first or last line is presented before the following press can leave it.

Git's unified diff and VS Code's editor diff can divide one large replacement differently. Better Git retains both the inner added-line runs and the broader `@@` group. An inner stop no more than five lines away and within the configured step remains change-to-change navigation; otherwise the broader group owns the press so VS Code cannot jump dozens of lines or roll into another file while that replacement still has an unread edge.

When the next or previous added/replaced run is already fully visible, Better Git selects its start without scrolling. VS Code's native command always centres its range, which can scroll backwards after a tall-hunk page step and then forwards on the following press. The visible-run hand-off avoids that round trip before it occurs. Deleted-only stops in between remain native, trim-whitespace-only replacements are excluded when the editor hides them, and unsaved documents defer to native navigation because Git's on-disk geometry is stale. Turning off tall-hunk staging also disables this hand-off.

Reversing direction always continues from the current caret. Previous does not reset to the bottom of the file, and Next does not restart from the top. When Previous enters a different file, Better Git VS Code deliberately lands at that file's last reviewable position so upward review begins in the right place.

## Late mouse staging

For Agentic Mouse's one-second follow-up gesture, capture the exact unstaged file inside the navigation queue before moving. Measure the deadline from command arrival, not from asynchronous Git or renderer completion. A rapid follow-up enters that same queue, so it cannot overtake capture. A new navigation replaces only the same mouse's origin; ordinary keyboard navigation and window focus loss clear it. Consume the origin once, and refuse expired, absent, ambiguous, staged-only, or no-longer-unstaged files without substituting the current selection.

When navigation already crossed files, stage the captured URI through the normal staging/Undo path and leave the destination open. When it stayed within the origin, use the normal Stage + Next/Previous operation with that captured file. Never navigate backwards to rediscover the origin.

## Why the old behavior became jumpy

Earlier implementations let viewport geometry and caret position compete as two sources of truth. Word wrap, sticky scroll, and `editor.cursorSurroundingLines` mean VS Code can legitimately keep a viewport top unchanged after a reveal request, or report a logical top that differs from the requested line. Treating that reported top as the next movement anchor caused repeated presses to drift, stop, overshoot and return, or roll into another file before the final lines had been read.

The stable implementation uses editor-scoped `TextEditor.revealRange` calls, keeps the requested caret target authoritative, and waits for the exact editor's rendering to settle. Input is serialized so rapid key repeats cannot race against a stale viewport or a file transition. Wrapped final lines are checked through their last visual segment before rollover; unwrapped long lines remain at column zero instead of being pulled sideways.

## Regression coverage

The isolated real VS Code Extension Development Host suite covers navigation scenarios including:

- repeated Next and Previous in wrapped untracked and staged-new files;
- a Source Control-opened plain merge-conflict file, including block traversal with SCM focus and cross-file landing in both directions;
- partial final steps at the top and bottom before cross-file rollover;
- direction reversal from the current caret;
- rapid queued input while Source Control retains focus;
- a viewport-fit hunk stranded below a preceding hunk;
- the exact copied `profile-pic.service.ts` replacement where native Next jumps from line 53 to line 149, proving default +10, custom +7, mirrored -7, and same-file retention;
- tall-hunk top, middle, and final-edge presentation in both directions;
- wrapped final-line visual segments;
- backward and stage-and-Previous cross-file landing;
- partially staged files whose working-tree and index diff geometry differs; and
- monotonic visible-range events that fail if overshoot-and-return is reintroduced.

The nearby-run regressions first prove native backward recentering, then require monotonic rapid Next and Previous. Separate cases preserve deleted-only stops, trim-whitespace settings, and unsaved changes. Run the optional real-keyboard acceptance harness with `BGV_UI_SMOKE=1 BGV_UI_SCROLL=1`: it waits for three Next and two Previous inputs and verifies both the exact caret sequence and viewport events without invoking the navigation commands itself.

The detailed incident evidence remains in [`LEARNINGS.md`](../LEARNINGS.md), and the user-facing release history is in [`CHANGELOG.md`](../CHANGELOG.md).
