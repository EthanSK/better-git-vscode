import * as assert from "assert";
import {
    MouseHoldChordState,
    registerMouseShortRelease,
    resolveAdjacentMouseChord,
} from "../../mouseHoldChord";

// Agentic Mouse delivers the adjacent-cell chord as tagged F14, then F16 (bare in the live Karabiner
// rules), then tagged F15. These cases replay that synchronous input order against one hold record.
suite("Mouse hold adjacent chord", () => {
    const beginReleaseOnlyHold = (): MouseHoldChordState => ({ active: true, navigateOnButtonDown: false });

    test("pre-ready chord keeps the hold alive through F14 and resolves to cancel-and-undo", () => {
        for (const reviewItemCaptured of [true, false]) {
            const hold = beginReleaseOnlyHold();
            assert.strictEqual(
                registerMouseShortRelease(hold, reviewItemCaptured),
                reviewItemCaptured ? "pending" : "pending-without-review-item"
            );
            assert.strictEqual(hold.active, true, "F14 must not tear down a release-only hold");
            assert.strictEqual(hold.shortReleasePending, true);
            assert.strictEqual(resolveAdjacentMouseChord(hold), "cancel-and-undo");
        }
    });

    test("stage-ready chord resolves to cancel-only and preserves Undo history", () => {
        const hold = beginReleaseOnlyHold();
        hold.stageReadyRequested = true; // F20 arrived before the adjacent press.
        assert.strictEqual(registerMouseShortRelease(hold, true), "pending");
        assert.strictEqual(resolveAdjacentMouseChord(hold), "cancel-only");
    });

    test("readiness that could not light a stage-ready decoration returns the chord to Undo", () => {
        const hold = beginReleaseOnlyHold();
        hold.stageReadyRequested = true;
        hold.stageReadyRequested = false; // Queued F20 work found no unstaged review item.
        assert.strictEqual(resolveAdjacentMouseChord(hold), "cancel-and-undo");
    });

    test("F16 arriving before the queued F14 work decides from the live hold and F14 then clears", () => {
        // Physical dispatch order: F14 sync, F16 sync, then F14's queued work behind navigation.
        const hold = beginReleaseOnlyHold();
        assert.strictEqual(resolveAdjacentMouseChord(hold), "cancel-and-undo");
        hold.active = false; // cancelMouseNavigationHold ran synchronously for F16.
        assert.strictEqual(registerMouseShortRelease(hold, true), "cleared");
        assert.strictEqual(hold.shortReleasePending, undefined, "a cancelled hold must not queue a short navigation");
        assert.strictEqual(resolveAdjacentMouseChord(hold), "no-active-hold");
    });

    test("ended or missing holds never resolve to a cancel", () => {
        assert.strictEqual(resolveAdjacentMouseChord(undefined), "no-active-hold");
        assert.strictEqual(registerMouseShortRelease(undefined, false), "ignored");
        const finished: MouseHoldChordState = { active: false, navigateOnButtonDown: false, stageReadyRequested: true };
        assert.strictEqual(resolveAdjacentMouseChord(finished), "no-active-hold");
    });

    test("experimental button-down holds still clear on short release", () => {
        const hold: MouseHoldChordState = { active: true, navigateOnButtonDown: true };
        assert.strictEqual(registerMouseShortRelease(hold, true), "cleared");
        assert.strictEqual(hold.active, false);
        assert.strictEqual(hold.shortReleasePending, undefined);
    });
});
