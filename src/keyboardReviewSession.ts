// KEYBOARD REVIEW — Ethan's keyboard "eyes mode" (review changes).
//
// The old keyboard Shift + Next/Previous stages the whole current file straight away. Keyboard review instead
// builds the same pending staging set that a held mouse button or the Magic Wand builds in eyes
// mode: Next/Previous review hunks, crossing into another file adds the reviewed file being left, moving back
// removes it again, and the file still being viewed stays unstaged when the review is finished. Nothing
// reaches the Git index until an explicit finish, which runs the existing exact batch transaction and Undo.
//
// extension.ts implements this as one more review-hold source ("keyboard") on the existing hold machinery, so
// navigation, decorations, staging and Undo are shared rather than duplicated. This module only owns the rules
// that keep that source isolated: when a keyboard review may begin, where a keyboard press is routed, and when
// another gesture supersedes it. It never imports VS Code, so the rules are unit-tested directly.

export type KeyboardReviewDirection = "next" | "previous";

// The subset of a review-hold request these rules read.
export interface KeyboardReviewHold {
    active: boolean;
    // A finish has been admitted: its queued transaction now owns the captured selection.
    releaseQueued?: boolean;
}

export interface KeyboardReviewHolds<H extends KeyboardReviewHold> {
    // The keyboard-owned hold request, if any.
    readonly keyboard: H | undefined;
    // The hold that currently owns review input, from any source (mouse, wand or keyboard).
    readonly latest: H | undefined;
}

// A keyboard review is live only while its own unreleased request still owns review input. A mouse or wand
// gesture that began afterwards, a finish, a cancellation or any full navigation reset all end it.
export const liveKeyboardReview = <H extends KeyboardReviewHold>(holds: KeyboardReviewHolds<H>): H | undefined => {
    const hold = holds.keyboard;
    return hold?.active && !hold.releaseQueued && hold === holds.latest ? hold : undefined;
};

export type KeyboardReviewBeginDecision = "begin" | "already-active" | "other-hold-active";

// The keyboard never takes over a live mouse or wand gesture; that gesture's own release or cancel decides it.
// Beginning again during a live keyboard review changes nothing, so a repeated shortcut cannot restart (and
// silently discard) the selection being built.
export const decideKeyboardReviewBegin = <H extends KeyboardReviewHold>(
    holds: KeyboardReviewHolds<H>
): KeyboardReviewBeginDecision => {
    if (liveKeyboardReview(holds)) { return "already-active"; }
    return holds.latest?.active && holds.latest !== holds.keyboard ? "other-hold-active" : "begin";
};

// A keyboard step is never dropped. Without a live keyboard review (finished, cancelled, superseded, or one
// that could not start), the same press is ordinary change navigation.
export const decideKeyboardReviewStep = <H extends KeyboardReviewHold>(
    holds: KeyboardReviewHolds<H>
): "review" | "navigate" => liveKeyboardReview(holds) ? "review" : "navigate";

// Ordinary untagged Next/Previous (the keyboard keys and Command Palette) continue a live keyboard review
// instead of discarding its pending selection. This is decided from extension state in input order, not from
// a `when` context key that the renderer may not have received yet. Mouse-tagged navigation keeps its own
// meaning and supersedes the keyboard review.
export const routeChangeNavigation = <H extends KeyboardReviewHold>(
    holds: KeyboardReviewHolds<H>, source: unknown
): "review" | "navigate" => source === undefined && liveKeyboardReview(holds) ? "review" : "navigate";

// Clearing hold feedback for every source (another gesture beginning, immediate staging, ordinary navigation)
// or for the keyboard itself retires a still-active keyboard request without staging anything. A queued finish
// keeps its captured transaction, and a cancellation in progress (already inactive) keeps its origin so it can
// restore the starting view. Clearing another single source leaves the keyboard review alone.
export const keyboardReviewEndsWithFeedbackClear = <H extends KeyboardReviewHold>(
    holds: KeyboardReviewHolds<H>, clearedSource: string | undefined
): boolean => (clearedSource === undefined || clearedSource === "keyboard")
    && holds.keyboard?.active === true && !holds.keyboard.releaseQueued;

// Keyboard review commands take a direction string, or an object carrying one so a keybinding can add tags.
export const parseKeyboardReviewDirection = (args: unknown): KeyboardReviewDirection | undefined => {
    const direction = args && typeof args === "object" ? (args as { direction?: unknown }).direction : args;
    return direction === "next" || direction === "previous" ? direction : undefined;
};

// Publishes the `better-git-vscode.keyboardReviewActive` context key only when its value changes. Many hold
// transitions call update(); repeated identical values must not queue redundant renderer round trips.
export const KEYBOARD_REVIEW_CONTEXT_KEY = "better-git-vscode.keyboardReviewActive";

export class KeyboardReviewContext {
    private value: boolean | undefined;

    constructor(private readonly publish: (active: boolean) => void) {}

    get active(): boolean { return this.value === true; }

    update(active: boolean): void {
        if (this.value === active) { return; }
        this.value = active;
        try { this.publish(active); } catch { /* context publication is presentation only */ }
    }
}
