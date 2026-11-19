// Pure pending-set and eyes endpoint rules shared by mouse, wand and keyboard; run with npm test.
import * as assert from "assert";
import {
    createMouseStageSelection,
    moveMouseStageSelection,
    planMouseStagePreviewBoundary,
    reconcileMouseStageSelection,
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

    test("explicitly reviewing past an outer boundary includes the final eyes file on release", () => {
        for (const direction of ["next", "previous"] as const) {
            const index = direction === "next" ? 3 : 0;
            const start = createMouseStageSelection(items, index, direction)!;
            assert.deepStrictEqual(selectedMouseStageItems(start, true), [], "merely viewing the endpoint still excludes it");
            const end = planMouseStagePreviewBoundary(start, index, direction)!;
            assert.strictEqual(end.target, undefined, "never cross to another worktree");
            assert.deepStrictEqual(selectedMouseStageItems(end.selection, true), [items[index]]);
            const repeated = planMouseStagePreviewBoundary(end.selection, index, direction)!;
            assert.deepStrictEqual(selectedMouseStageItems(repeated.selection, true), [items[index]], "repeated ratchets are idempotent");
            assert.deepStrictEqual(selectedMouseStageItems(start, true), [], "earlier snapshots remain immutable");
            const back = planMouseStagePreviewBoundary(end.selection, index, direction === "next" ? "previous" : "next")!;
            assert.deepStrictEqual(selectedMouseStageItems(back.selection, true), [], "reversing removes the completed departing file");
        }
    });

    test("a manually opened outer file is included without selecting unrelated gaps", () => {
        const start = createMouseStageSelection(items, 0)!;
        const end = planMouseStagePreviewBoundary(start, 3, "next")!;
        assert.strictEqual(end.selection.cursorIndex, 3);
        assert.deepStrictEqual(selectedMouseStageItems(end.selection, true), ["a", "d"]);
    });

    // Ethan (2026-11-19): "sometimes BetterGit is skipping ... file as I go down". The held list used to be
    // frozen at the hold threshold; these cases pin the live-list refresh that replaced it. — Claude Fable 5.2
    const same = (item: string) => item;

    test("a file that becomes changed during the hold is the next stop instead of being skipped", () => {
        // His log: comments-filter-bar.component.html was reviewed, then the walk jumped to comments-list
        // because another agent had only just changed comments-filter-bar.component.ts.
        const frozen = ["filter-bar.html", "list.html", "list.ts"];
        const held = createMouseStageSelection(frozen, 0)!;
        const live = ["filter-bar.html", "filter-bar.ts", "list.html", "list.ts"];
        const fresh = reconcileMouseStageSelection(held, held.cursorIndex, "next", live, same);
        assert.deepStrictEqual(fresh.selection.items, live);
        const moved = moveMouseStageSelection(fresh.selection, 1);
        assert.strictEqual(moved.items[moved.cursorIndex], "filter-bar.ts");
        assert.deepStrictEqual(selectedMouseStageItems(moved), ["filter-bar.html", "filter-bar.ts"]);
        assert.deepStrictEqual(held.items, frozen, "the earlier snapshot stays immutable");
    });

    for (const direction of ["next", "previous"] as const) {
        test(`a previously marked file moving across the cursor cannot hide the next file (${direction})`, () => {
            const forward = direction === "next";
            const inOrder = (values: string[]) => forward ? values : values.reverse();
            const delta = forward ? 1 : -1;
            const initial = inOrder(["z", "a", "c"]);
            const held = moveMouseStageSelection(createMouseStageSelection(initial, initial.indexOf("z"), direction)!, delta);
            const fresh = reconcileMouseStageSelection(held, held.cursorIndex, direction, inOrder(["a", "b", "c", "z"]), same);
            assert.deepStrictEqual(fresh.selection.items, inOrder(["z", "a", "b", "c"]));
            assert.deepStrictEqual(selectedMouseStageItems(fresh.selection), inOrder(["z", "a"]));
            const fileStep = moveMouseStageSelection(fresh.selection, delta);
            assert.strictEqual(fileStep.items[fileStep.cursorIndex], "b");
            assert.strictEqual(planMouseStagePreviewBoundary(fresh.selection, fresh.fromIndex, direction)?.target, "b");
        });
    }

    test("the marked set and everything behind the cursor survive a refresh unchanged", () => {
        let held = createMouseStageSelection(["a", "b", "c", "d"], 0)!;
        held = moveMouseStageSelection(moveMouseStageSelection(held, 1), 1); // a, b, c marked; cursor on c
        // "a" was staged elsewhere, "b2" appeared behind the cursor, "c2" appeared ahead and "d" was reverted.
        const fresh = reconcileMouseStageSelection(held, held.cursorIndex, "next", ["b", "b2", "c", "c2", "e"], same);
        assert.deepStrictEqual(fresh.selection.items, ["a", "b", "c", "c2", "e"], "only the road ahead follows the live list");
        assert.strictEqual(fresh.fromIndex, 2);
        assert.strictEqual(fresh.selection.cursorIndex, 2);
        assert.deepStrictEqual(selectedMouseStageItems(fresh.selection), ["a", "b", "c"], "membership is never edited by a refresh");
        const moved = moveMouseStageSelection(fresh.selection, 1);
        assert.deepStrictEqual(selectedMouseStageItems(moved), ["a", "b", "c", "c2"]);
    });

    test("an unmarked file with nothing left to review is dropped from the road ahead", () => {
        const held = createMouseStageSelection(["a", "b", "c"], 0)!;
        const fresh = reconcileMouseStageSelection(held, 0, "next", ["a", "c"], same);
        const moved = moveMouseStageSelection(fresh.selection, 1);
        assert.strictEqual(moved.items[moved.cursorIndex], "c");
        assert.deepStrictEqual(selectedMouseStageItems(moved), ["a", "c"]);
    });

    test("travelling up refreshes the files above and keeps every marked file", () => {
        let held = createMouseStageSelection(["a", "c", "d"], 2, "previous")!;
        held = moveMouseStageSelection(held, -1); // c, d marked; cursor on c
        const fresh = reconcileMouseStageSelection(held, held.cursorIndex, "previous", ["a", "b", "c", "d"], same);
        assert.deepStrictEqual(fresh.selection.items, ["a", "b", "c", "d"]);
        assert.strictEqual(fresh.fromIndex, 2, "indices shift when a file is added above");
        assert.strictEqual(fresh.selection.cursorIndex, 2);
        assert.deepStrictEqual(selectedMouseStageItems(fresh.selection), ["c", "d"]);
        const moved = moveMouseStageSelection(fresh.selection, -1);
        assert.strictEqual(moved.items[moved.cursorIndex], "b");
        assert.deepStrictEqual(selectedMouseStageItems(moved), ["b", "c", "d"]);
    });

    test("a marked file ahead that Git no longer lists keeps its place and its membership", () => {
        // Built upward from d, so b, c and d are marked; walking back down has marked files ahead.
        let held = createMouseStageSelection(["a", "b", "c", "d", "e"], 3, "previous")!;
        held = moveMouseStageSelection(moveMouseStageSelection(held, -1), -1); // cursor on b
        const fresh = reconcileMouseStageSelection(held, held.cursorIndex, "next", ["a", "b", "b2", "d", "e"], same);
        assert.deepStrictEqual(fresh.selection.items, ["a", "b", "b2", "c", "d", "e"]);
        assert.deepStrictEqual(selectedMouseStageItems(fresh.selection), ["b", "c", "d"]);
    });

    test("nothing changing ahead returns the very same selection", () => {
        const held = moveMouseStageSelection(createMouseStageSelection(["a", "b", "c"], 0)!, 1);
        // "a0" is new but behind the cursor: it is not part of this step's road.
        assert.strictEqual(reconcileMouseStageSelection(held, held.cursorIndex, "next", ["a0", "a", "b", "c"], same).selection, held);
        assert.strictEqual(reconcileMouseStageSelection(held, held.cursorIndex, "previous", ["a", "b", "c", "d"], same).selection, held);
        assert.strictEqual(reconcileMouseStageSelection(held, -1, "next", ["x"], same).selection, held);
        assert.strictEqual(reconcileMouseStageSelection(held, 3, "next", ["x"], same).selection, held);
    });

    test("a new neighbour is visited even when the current file itself left the live list", () => {
        const held = moveMouseStageSelection(createMouseStageSelection(["a", "b", "c"], 0)!, 1); // cursor on b
        const fresh = reconcileMouseStageSelection(held, held.cursorIndex, "next", ["a", "b2", "c"], same);
        assert.deepStrictEqual(fresh.selection.items, ["a", "b", "b2", "c"]);
        assert.deepStrictEqual(selectedMouseStageItems(fresh.selection), ["a", "b"]);
    });

    test("an eyes boundary planned on the refreshed list previews the new file and keeps a finished endpoint", () => {
        const start = createMouseStageSelection(["a", "c"], 0)!;
        const fresh = reconcileMouseStageSelection(start, 0, "next", ["a", "b", "c"], same);
        const plan = planMouseStagePreviewBoundary(fresh.selection, fresh.fromIndex, "next")!;
        assert.strictEqual(plan.target, "b");
        assert.deepStrictEqual(selectedMouseStageItems(plan.selection, true), ["a"], "the new eyes preview stays unstaged on release");
        // A file appearing after the explicitly finished last file reopens the road without losing that approval.
        const last = createMouseStageSelection(["a", "b"], 1)!;
        const finished = planMouseStagePreviewBoundary(last, 1, "next")!.selection;
        assert.deepStrictEqual(selectedMouseStageItems(finished, true), ["b"]);
        const grown = reconcileMouseStageSelection(finished, 1, "next", ["a", "b", "c"], same);
        assert.strictEqual(grown.selection.reviewedEndpoint, 1);
        const onward = planMouseStagePreviewBoundary(grown.selection, grown.fromIndex, "next")!;
        assert.strictEqual(onward.target, "c");
        assert.deepStrictEqual(selectedMouseStageItems(onward.selection, true), ["b"]);
        // Travelling up shifts the finished endpoint with its file.
        const first = createMouseStageSelection(["b", "c"], 0, "previous")!;
        const top = planMouseStagePreviewBoundary(first, 0, "previous")!.selection;
        const above = reconcileMouseStageSelection(top, 0, "previous", ["a", "b", "c"], same);
        assert.strictEqual(above.fromIndex, 1);
        assert.strictEqual(above.selection.reviewedEndpoint, 1);
        assert.strictEqual(above.selection.items[above.selection.cursorIndex], "b");
    });
});
