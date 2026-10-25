import * as assert from "assert";
import {
    createMouseStageSelection,
    moveMouseStageSelection,
    planMouseStagePreviewBoundary,
    selectedMouseStageItems,
} from "../../mouseStageSelection";

suite("Mouse stage selection", () => {
    const items = ["a", "b", "c", "d"];

    test("starts at the held file and expands one item per wheel step", () => {
        const start = createMouseStageSelection(items, 1);
        assert.ok(start);
        const one = moveMouseStageSelection(start, 1);
        const two = moveMouseStageSelection(one, 1);
        assert.deepStrictEqual(selectedMouseStageItems(start), ["b"]);
        assert.deepStrictEqual(selectedMouseStageItems(one), ["b", "c"]);
        assert.deepStrictEqual(selectedMouseStageItems(two), ["b", "c", "d"]);
    });

    test("reverse wheel removes the departing file even past the starting file", () => {
        const start = createMouseStageSelection(items, 2);
        assert.ok(start);
        const below = moveMouseStageSelection(start, 1);
        const anchor = moveMouseStageSelection(below, -1);
        const above = moveMouseStageSelection(anchor, -1);
        assert.deepStrictEqual(selectedMouseStageItems(below), ["c", "d"]);
        assert.deepStrictEqual(selectedMouseStageItems(anchor), ["c"]);
        assert.deepStrictEqual(selectedMouseStageItems(above), ["b"]);
    });

    test("clamps at both ends and rejects an invalid anchor", () => {
        const first = createMouseStageSelection(items, 0);
        const last = createMouseStageSelection(items, items.length - 1);
        assert.ok(first);
        assert.ok(last);
        assert.strictEqual(moveMouseStageSelection(first, -1).cursorIndex, 0);
        assert.strictEqual(moveMouseStageSelection(last, 1).cursorIndex, items.length - 1);
        assert.strictEqual(createMouseStageSelection(items, -1), undefined);
        assert.strictEqual(createMouseStageSelection(items, items.length), undefined);
    });

    test("wand circles can build either way after returning to a single endpoint", () => {
        for (const initial of ["next", "previous"] as const) {
            let selection = createMouseStageSelection(items, 1, initial, true)!;
            selection = moveMouseStageSelection(selection, 1);
            selection = moveMouseStageSelection(selection, 1);
            assert.deepStrictEqual(selectedMouseStageItems(selection), ["b", "c", "d"]);
            selection = moveMouseStageSelection(selection, -1);
            assert.deepStrictEqual(selectedMouseStageItems(selection), ["b", "c"]);
            selection = moveMouseStageSelection(selection, -1);
            selection = moveMouseStageSelection(selection, -1);
            assert.deepStrictEqual(selectedMouseStageItems(selection), ["a", "b"]);
            assert.deepStrictEqual(selectedMouseStageItems(selection, true), ["b"]);
            selection = moveMouseStageSelection(selection, 1);
            selection = moveMouseStageSelection(selection, 1);
            assert.deepStrictEqual(selectedMouseStageItems(selection), ["b", "c"]);
        }
    });

    test("preview backtracking removes the departing file and revisiting adds it again", () => {
        const marked = moveMouseStageSelection(createMouseStageSelection(items, 1)!, 1);
        const next = planMouseStagePreviewBoundary(marked, 2, "next")!;
        assert.strictEqual(next.target, "d");
        assert.deepStrictEqual(selectedMouseStageItems(next.selection), ["b", "c", "d"]);
        const back = planMouseStagePreviewBoundary(next.selection, 3, "previous")!;
        assert.strictEqual(back.target, "c");
        assert.deepStrictEqual(selectedMouseStageItems(back.selection), ["b", "c"]);
        const again = planMouseStagePreviewBoundary(back.selection, 2, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(again.selection), ["b", "c", "d"]);
        const origin = planMouseStagePreviewBoundary(back.selection, 2, "previous")!;
        assert.deepStrictEqual(selectedMouseStageItems(origin.selection), ["b"]);
        const above = planMouseStagePreviewBoundary(origin.selection, 1, "previous")!;
        assert.deepStrictEqual(selectedMouseStageItems(above.selection), ["a"]);
        const home = planMouseStagePreviewBoundary(above.selection, 0, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(home.selection), ["a", "b"]);
        assert.deepStrictEqual(selectedMouseStageItems(marked), ["b", "c"], "original selection is immutable");
    });

    test("previous review grows above its origin and contracts when returning downward", () => {
        const start = createMouseStageSelection(items, 3, "previous")!;
        const first = planMouseStagePreviewBoundary(start, 3, "previous")!;
        const second = planMouseStagePreviewBoundary(first.selection, 2, "previous")!;
        assert.deepStrictEqual(selectedMouseStageItems(second.selection), ["b", "c", "d"]);
        const back = planMouseStagePreviewBoundary(second.selection, 1, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(back.selection), ["c", "d"]);
        const home = planMouseStagePreviewBoundary(back.selection, 2, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(home.selection), ["d"]);
    });

    test("file mode removes previewed files and eyes mode removes file-mode selections", () => {
        for (const direction of ["next", "previous"] as const) {
            const delta = direction === "next" ? 1 : -1;
            const reverse = direction === "next" ? "previous" : "next";
            const start = createMouseStageSelection(items, direction === "next" ? 0 : 3, direction)!;
            const eyes = planMouseStagePreviewBoundary(start, start.cursorIndex, direction)!.selection;
            const file = moveMouseStageSelection(eyes, delta);
            const fileBack = moveMouseStageSelection(file, delta === 1 ? -1 : 1);
            assert.deepStrictEqual(selectedMouseStageItems(fileBack), selectedMouseStageItems(eyes));
            const eyesBack = planMouseStagePreviewBoundary(fileBack, fileBack.cursorIndex, reverse)!.selection;
            assert.deepStrictEqual(selectedMouseStageItems(eyesBack), selectedMouseStageItems(start));
            assert.deepStrictEqual(selectedMouseStageItems(start), [items[start.cursorIndex]], "previous values remain immutable");
        }
    });

    test("preview includes a manually reviewed file without marking unrelated gaps", () => {
        const marked = createMouseStageSelection(items, 0)!;
        const next = planMouseStagePreviewBoundary(marked, 2, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(next.selection), ["a", "c", "d"]);
        const back = planMouseStagePreviewBoundary(next.selection, 3, "previous")!;
        assert.deepStrictEqual(selectedMouseStageItems(back.selection), ["a", "c"]);
        const nextBack = planMouseStagePreviewBoundary(back.selection, 2, "previous")!;
        assert.deepStrictEqual(selectedMouseStageItems(nextBack.selection), ["a", "b"]);
    });

    test("eyes release omits only the final endpoint without changing the pending set", () => {
        for (const direction of ["next", "previous"] as const) {
            const start = createMouseStageSelection(items, direction === "next" ? 0 : 3, direction)!;
            assert.deepStrictEqual(selectedMouseStageItems(start, true), []);
            const first = planMouseStagePreviewBoundary(start, start.cursorIndex, direction)!.selection;
            const second = planMouseStagePreviewBoundary(first, first.cursorIndex, direction)!.selection;
            assert.deepStrictEqual(selectedMouseStageItems(second, true), direction === "next" ? ["a", "b"] : ["c", "d"]);
            assert.strictEqual(selectedMouseStageItems(second).length, 3, "ordinary mode and pending membership remain intact");
        }
    });

    test("preview clamps at both worktree ends and retains its pending set", () => {
        const first = createMouseStageSelection(items, 0)!;
        const last = createMouseStageSelection(items, 3)!;
        for (let n = 0; n < 4; n++) {
            const forward = planMouseStagePreviewBoundary(last, 3, "next")!;
            assert.strictEqual(forward.target, undefined);
            assert.deepStrictEqual(selectedMouseStageItems(forward.selection), ["d"]);
            const backward = planMouseStagePreviewBoundary(first, 0, "previous")!;
            assert.strictEqual(backward.target, undefined);
            assert.deepStrictEqual(selectedMouseStageItems(backward.selection), ["a"]);
        }
        assert.strictEqual(planMouseStagePreviewBoundary(first, -1, "next"), undefined);
        assert.strictEqual(planMouseStagePreviewBoundary(first, 4, "next"), undefined);
    });

    test("an extra Next beyond the final eyes preview confirms it once without moving", () => {
        const start = createMouseStageSelection(items, 2)!;
        const last = planMouseStagePreviewBoundary(start, 2, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(last.selection, true), ["c"]);
        const confirmed = planMouseStagePreviewBoundary(last.selection, 3, "next")!;
        assert.strictEqual(confirmed.target, undefined);
        assert.strictEqual(confirmed.selection.cursorIndex, 3);
        assert.strictEqual(confirmed.selection.includeCurrentPreview, true);
        assert.deepStrictEqual(selectedMouseStageItems(confirmed.selection, true), ["c", "d"]);
        const repeated = planMouseStagePreviewBoundary(confirmed.selection, 3, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(repeated.selection, true), ["c", "d"]);
        assert.deepStrictEqual(selectedMouseStageItems(last.selection, true), ["c"], "confirmation does not mutate the old selection");
    });

    test("backtracking clears final confirmation across eyes and file modes", () => {
        const last = planMouseStagePreviewBoundary(createMouseStageSelection(items, 3)!, 3, "next")!.selection;
        for (const previous of [planMouseStagePreviewBoundary(last, 3, "previous")!.selection, moveMouseStageSelection(last, -1)]) {
            assert.strictEqual(previous.includeCurrentPreview, false);
            assert.deepStrictEqual(selectedMouseStageItems(previous, true), []);
            assert.deepStrictEqual(selectedMouseStageItems(previous), ["c"]);
            const revisit = planMouseStagePreviewBoundary(previous, 2, "next")!.selection;
            assert.deepStrictEqual(selectedMouseStageItems(revisit, true), ["c"], "revisited last file needs explicit Next confirmation again");
        }
        const first = planMouseStagePreviewBoundary(createMouseStageSelection(items, 0)!, 0, "previous")!.selection;
        assert.deepStrictEqual(selectedMouseStageItems(first, true), [], "Previous at the top does not confirm anything");
    });

    test("single-file and manually entered final previews confirm only the current file", () => {
        const single = planMouseStagePreviewBoundary(createMouseStageSelection(["only"], 0)!, 0, "next")!.selection;
        assert.deepStrictEqual(selectedMouseStageItems(single, true), ["only"]);
        const manual = planMouseStagePreviewBoundary(createMouseStageSelection(items, 0)!, 3, "next")!.selection;
        assert.deepStrictEqual(selectedMouseStageItems(manual, true), ["a", "d"], "manual entry never includes unreviewed gaps");
    });
});
