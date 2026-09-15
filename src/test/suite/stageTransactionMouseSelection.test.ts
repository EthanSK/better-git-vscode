import * as assert from "assert";
import {
    createMouseStageSelection,
    moveMouseStageSelection,
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
});
