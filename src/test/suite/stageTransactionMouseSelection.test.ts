import * as assert from "assert";
import {
    createMouseStageSelection,
    moveMouseStageSelection,
    planMouseStageBoundary,
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

    test("commits the marked range at a boundary and arms the next file", () => {
        const marked = moveMouseStageSelection(createMouseStageSelection(items, 1)!, 1);
        assert.deepStrictEqual(planMouseStageBoundary(marked, 2, "next"), {
            staged: ["b", "c"], remaining: ["a", "d"], target: "d",
        });
    });

    test("includes a reviewed file outside the marked range without staging unmarked gaps", () => {
        const marked = createMouseStageSelection(items, 0)!;
        assert.deepStrictEqual(planMouseStageBoundary(marked, 2, "next"), {
            staged: ["a", "c"], remaining: ["b", "d"], target: "d",
        });
        assert.deepStrictEqual(planMouseStageBoundary(marked, 2, "previous"), {
            staged: ["a", "c"], remaining: ["b", "d"], target: "d",
        });
    });

    test("reverse boundary keeps review in the same change list and stops when exhausted", () => {
        const marked = createMouseStageSelection(items, 1)!;
        assert.deepStrictEqual(planMouseStageBoundary(marked, 1, "previous"), {
            staged: ["b"], remaining: ["a", "c", "d"], target: "a",
        });
        const all = moveMouseStageSelection(createMouseStageSelection(items, 0)!, 1);
        const allMarked = moveMouseStageSelection(moveMouseStageSelection(all, 1), 1);
        assert.deepStrictEqual(planMouseStageBoundary(allMarked, 3, "next"), {
            staged: items, remaining: [], target: undefined,
        });
        assert.strictEqual(planMouseStageBoundary(marked, -1, "next"), undefined);
    });
});
