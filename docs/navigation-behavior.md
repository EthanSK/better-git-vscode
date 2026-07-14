# How Agentic Git navigation works

Agentic Git treats change review as one continuous, reversible sequence. The same Next and Previous commands must behave predictably in ordinary diffs, tall hunks, brand-new files, staged files, and cross-file transitions.

## The navigation contract

The current caret is the review position. Every press starts from that position; the viewport is used only to present it. Agentic Git does not keep a separate forward/backward state machine that can drift away from what the user is reading.

For a brand-new file, Next and Previous move by the configured logical-line step (five lines by default):

1. Compute `caret ± step`.
2. Clamp the target to line 1 or the final line.
3. Move the caret once and reveal that exact target in the same editor.
4. If the remaining distance is smaller than a full step, consume that partial step and visibly present the edge.
5. Only a later press, made while the caret is already at the presented edge, may move to another file.

Tall diff hunks follow the same rule at hunk boundaries. A hunk that fits in the viewport remains normal hunk-to-hunk navigation. A hunk that does not fit is reviewed in overlapping screen-sized stages; its exact first or last line is presented before the following press can leave it.

Reversing direction always continues from the current caret. Previous does not reset to the bottom of the file, and Next does not restart from the top. When Previous enters a different file, Agentic Git deliberately lands at that file's last reviewable position so upward review begins in the right place.

## Why the old behavior became jumpy

Earlier implementations let viewport geometry and caret position compete as two sources of truth. Word wrap, sticky scroll, and `editor.cursorSurroundingLines` mean VS Code can legitimately keep a viewport top unchanged after a reveal request, or report a logical top that differs from the requested line. Treating that reported top as the next movement anchor caused repeated presses to drift, stop, overshoot and return, or roll into another file before the final lines had been read.

The stable implementation uses editor-scoped `TextEditor.revealRange` calls, keeps the requested caret target authoritative, and waits for the exact editor's rendering to settle. Input is serialized so rapid key repeats cannot race against a stale viewport or a file transition. Wrapped final lines are checked through their last visual segment before rollover; unwrapped long lines remain at column zero instead of being pulled sideways.

## Regression coverage

The isolated real VS Code Extension Development Host suite covers 35 scenarios, including:

- repeated Next and Previous in wrapped untracked and staged-new files;
- partial final steps at the top and bottom before cross-file rollover;
- direction reversal from the current caret;
- rapid queued input while Source Control retains focus;
- tall-hunk top, middle, and final-edge presentation in both directions;
- wrapped final-line visual segments;
- backward and stage-and-Previous cross-file landing;
- partially staged files whose working-tree and index diff geometry differs; and
- monotonic visible-range events that fail if overshoot-and-return is reintroduced.

The detailed incident evidence remains in [`LEARNINGS.md`](../LEARNINGS.md), and the user-facing release history is in [`CHANGELOG.md`](../CHANGELOG.md).
