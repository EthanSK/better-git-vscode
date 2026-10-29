import * as assert from "assert";
import {
    decideKeyboardReviewBegin,
    decideKeyboardReviewStep,
    KeyboardReviewContext,
    KeyboardReviewHold,
    keyboardReviewEndsWithFeedbackClear,
    liveKeyboardReview,
    parseKeyboardReviewDirection,
    routeChangeNavigation,
} from "../../keyboardReviewSession";
import {
    createMouseStageSelection,
    planMouseStagePreviewBoundary,
    selectedMouseStageItems,
} from "../../mouseStageSelection";

// Keyboard review is Ethan's keyboard eyes mode: the same pending selection as the held mouse/wand eyes wheel.
suite("Keyboard review session", () => {
    const hold = (state: Partial<KeyboardReviewHold> = {}): KeyboardReviewHold => ({ active: true, ...state });

    test("is live only while its own unreleased request owns review input", () => {
        const keyboard = hold();
        assert.strictEqual(liveKeyboardReview({ keyboard, latest: keyboard }), keyboard);
        assert.strictEqual(liveKeyboardReview({ keyboard: undefined, latest: undefined }), undefined);
        assert.strictEqual(liveKeyboardReview({ keyboard: hold({ active: false }), latest: undefined }), undefined, "cancelled");
        const finishing = hold({ active: false, releaseQueued: true });
        assert.strictEqual(liveKeyboardReview({ keyboard: finishing, latest: finishing }), undefined, "finish admitted");
        assert.strictEqual(liveKeyboardReview({ keyboard, latest: hold() }), undefined, "a mouse or wand gesture began afterwards");
    });

    test("begins only when no other gesture owns review input and never restarts a live review", () => {
        assert.strictEqual(decideKeyboardReviewBegin({ keyboard: undefined, latest: undefined }), "begin");
        const keyboard = hold();
        assert.strictEqual(decideKeyboardReviewBegin({ keyboard, latest: keyboard }), "already-active");
        assert.strictEqual(decideKeyboardReviewBegin({ keyboard: undefined, latest: hold() }), "other-hold-active",
            "a live mouse or wand hold is never taken over");
        assert.strictEqual(decideKeyboardReviewBegin({ keyboard: undefined, latest: hold({ active: false }) }), "begin",
            "an ended gesture does not block");
        const finishing = hold({ active: false, releaseQueued: true });
        assert.strictEqual(decideKeyboardReviewBegin({ keyboard: finishing, latest: finishing }), "begin",
            "a new review may begin while the previous finish is still staging");
    });

    test("keeps every step: review while live, otherwise ordinary navigation", () => {
        const keyboard = hold();
        assert.strictEqual(decideKeyboardReviewStep({ keyboard, latest: keyboard }), "review");
        for (const holds of [
            { keyboard: undefined, latest: undefined },
            { keyboard: hold({ active: false }), latest: undefined },
            { keyboard: hold({ active: false, releaseQueued: true }), latest: undefined },
            { keyboard, latest: hold() },
        ]) {
            assert.strictEqual(decideKeyboardReviewStep(holds), "navigate");
        }
    });

    test("untagged ordinary navigation continues a live review; mouse-tagged navigation does not", () => {
        const keyboard = hold();
        const live = { keyboard, latest: keyboard };
        assert.strictEqual(routeChangeNavigation(live, undefined), "review");
        assert.strictEqual(routeChangeNavigation(live, "corsair"), "navigate");
        assert.strictEqual(routeChangeNavigation(live, "razer"), "navigate");
        assert.strictEqual(routeChangeNavigation({ keyboard: undefined, latest: undefined }, undefined), "navigate");
        assert.strictEqual(routeChangeNavigation({ keyboard, latest: hold() }, undefined), "navigate",
            "after a mouse hold supersedes the review, Next is ordinary navigation again");
    });

    test("generic feedback clears retire only a still-active, unreleased keyboard review", () => {
        const keyboard = hold();
        const holds = { keyboard, latest: keyboard };
        assert.strictEqual(keyboardReviewEndsWithFeedbackClear(holds, undefined), true, "another gesture or immediate stage");
        assert.strictEqual(keyboardReviewEndsWithFeedbackClear(holds, "keyboard"), true);
        assert.strictEqual(keyboardReviewEndsWithFeedbackClear(holds, "corsair"), false, "clearing one mouse source");
        const finishing = hold({ active: false, releaseQueued: true });
        assert.strictEqual(keyboardReviewEndsWithFeedbackClear({ keyboard: finishing, latest: finishing }, undefined), false,
            "a queued finish keeps its captured transaction");
        assert.strictEqual(keyboardReviewEndsWithFeedbackClear({ keyboard: hold({ active: false }), latest: undefined }, "keyboard"),
            false, "a queued cancel keeps its origin to restore the starting view");
        assert.strictEqual(keyboardReviewEndsWithFeedbackClear({ keyboard: undefined, latest: undefined }, undefined), false);
    });

    test("parses only explicit directions", () => {
        assert.strictEqual(parseKeyboardReviewDirection("next"), "next");
        assert.strictEqual(parseKeyboardReviewDirection({ direction: "previous", source: "keyboard" }), "previous");
        for (const invalid of [undefined, null, "up", 1, {}, { direction: "down" }, ["next"]]) {
            assert.strictEqual(parseKeyboardReviewDirection(invalid), undefined);
        }
    });

    test("publishes the context key once per change and survives a failing publisher", () => {
        const published: boolean[] = [];
        const context = new KeyboardReviewContext(active => { published.push(active); });
        assert.strictEqual(context.active, false);
        context.update(false);
        context.update(false);
        context.update(true);
        context.update(true);
        context.update(false);
        assert.deepStrictEqual(published, [false, true, false]);
        const failing = new KeyboardReviewContext(() => { throw new Error("renderer unavailable"); });
        failing.update(true);
        assert.strictEqual(failing.active, true);
    });

    // The keyboard source uses the shared selection with the wand's endpoint rebase: no held button fixes a
    // direction, so after moving back to a single file either direction can start collecting again.
    test("eyes steps add the departing file, reverse removes it, and finish leaves the viewed file out", () => {
        const items = ["a", "b", "c", "d"];
        let selection = createMouseStageSelection(items, 1, "next", true)!;
        const cross = (direction: "next" | "previous") => {
            const plan = planMouseStagePreviewBoundary(selection, selection.cursorIndex, direction)!;
            selection = plan.selection;
            return plan.target;
        };
        const staged = () => selectedMouseStageItems(selection, true);
        assert.deepStrictEqual(staged(), [], "finishing on the starting file stages nothing");
        assert.strictEqual(cross("next"), "c");
        assert.strictEqual(cross("next"), "d");
        assert.deepStrictEqual(staged(), ["b", "c"], "reviewed files are pending; the viewed file is excluded");
        assert.strictEqual(cross("previous"), "c");
        assert.deepStrictEqual(staged(), ["b"], "moving back removes the file being left");
        assert.strictEqual(cross("previous"), "b");
        assert.deepStrictEqual(staged(), [], "back at the start nothing is pending");
        assert.strictEqual(cross("previous"), "a");
        assert.deepStrictEqual(staged(), ["b"], "beginning with Next does not stop a review upwards");
        assert.strictEqual(cross("previous"), undefined, "the worktree's first file is a boundary, never another worktree");
        assert.deepStrictEqual(staged(), ["b"], "an outer boundary changes nothing");
    });
});
