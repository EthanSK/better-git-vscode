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

    test("reverse wheel steps contract the range and then grow above the anchor", () => {
        const start = createMouseStageSelection(items, 2);
        assert.ok(start);
        const below = moveMouseStageSelection(start, 1);
        const anchor = moveMouseStageSelection(below, -1);
        const above = moveMouseStageSelection(anchor, -1);
        assert.deepStrictEqual(selectedMouseStageItems(below), ["c", "d"]);
        assert.deepStrictEqual(selectedMouseStageItems(anchor), ["c"]);
        assert.deepStrictEqual(selectedMouseStageItems(above), ["b", "c"]);
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
        assert.deepStrictEqual(selectedMouseStageItems(above.selection), ["a", "b"]);
        const home = planMouseStagePreviewBoundary(above.selection, 0, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(home.selection), ["b"]);
        assert.deepStrictEqual(selectedMouseStageItems(marked), ["b", "c"], "original selection is immutable");
    });

    test("previous review grows above its origin and contracts when returning downward", () => {
        const start = createMouseStageSelection(items, 3)!;
        const first = planMouseStagePreviewBoundary(start, 3, "previous")!;
        const second = planMouseStagePreviewBoundary(first.selection, 2, "previous")!;
        assert.deepStrictEqual(selectedMouseStageItems(second.selection), ["b", "c", "d"]);
        const back = planMouseStagePreviewBoundary(second.selection, 1, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(back.selection), ["c", "d"]);
        const home = planMouseStagePreviewBoundary(back.selection, 2, "next")!;
        assert.deepStrictEqual(selectedMouseStageItems(home.selection), ["d"]);
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
});
