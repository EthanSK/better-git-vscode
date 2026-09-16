// Input-order state of one physical Next/Previous mouse hold.
//
// Agentic Mouse's adjacent-cell chord reaches Better Git as three VS Code commands in this order:
// source-tagged F14 (short-release registration), F16 (exact Undo) and source-tagged F15 (transaction
// boundary). The live Karabiner rules emit that F16 *bare*, so it arrives through the user's plain
// `f16` keybinding without a mouse source, while Better Git's own contributed bindings tag it per mouse.
// Both deliveries must resolve through the same rule, decided from synchronous input order rather than
// from queued editor or Git work: before the 200 ms readiness event the chord cancels the unfinished
// hold and performs the previous exact staging Undo; once readiness has arrived it cancels only the
// pending stage and preserves Undo history.

export interface MouseHoldChordState {
    active: boolean;
    shortReleasePending?: boolean;
    // Set synchronously when the readiness command arrives, before its queued work. Cleared again only
    // when that queued work proves no stage-ready decoration can appear for this hold.
    stageReadyRequested?: boolean;
    // True for the experimental button-down navigation path; false for the default release-only path.
    navigateOnButtonDown?: boolean;
}

export type AdjacentMouseChordOutcome = "cancel-and-undo" | "cancel-only" | "no-active-hold";

export const resolveAdjacentMouseChord = (
    hold: MouseHoldChordState | undefined
): AdjacentMouseChordOutcome => {
    if (!hold?.active) {
        return "no-active-hold";
    }
    return hold.stageReadyRequested === true ? "cancel-only" : "cancel-and-undo";
};

export type MouseShortReleaseOutcome =
    | "pending"
    | "pending-without-review-item"
    | "cleared"
    | "ignored";

// A release-only hold must survive its own F14 until the F15 boundary or an adjacent F16 decides it,
// even when button-down captured no unstaged review item. Tearing the hold down here would make a
// quick adjacent chord look like stale input and silently drop the Undo the user asked for.
export const registerMouseShortRelease = (
    hold: MouseHoldChordState | undefined,
    reviewItemCaptured: boolean
): MouseShortReleaseOutcome => {
    if (!hold) {
        return "ignored";
    }
    if (hold.active && hold.navigateOnButtonDown !== true) {
        hold.shortReleasePending = true;
        return reviewItemCaptured ? "pending" : "pending-without-review-item";
    }
    hold.active = false;
    return "cleared";
};
