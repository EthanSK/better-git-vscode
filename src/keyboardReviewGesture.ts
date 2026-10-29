// Ethan's keyboard mode cycle: hold Option, tap/release Shift, then release all gesture keys to stage.
// This only interprets physical state. Shared review selection/Git/Undo remain in extension.ts.
export type KeyboardReviewMode = "normal" | "changes" | "files";
export interface ReviewKeyState { option: boolean; shift: boolean; navigation: boolean; usedShift: boolean; }

export class KeyboardReviewGesture {
    mode: KeyboardReviewMode = "normal";
    private previous: ReviewKeyState | undefined;
    private shiftTap = false;
    private consumed = false;
    private blocked = false;
    private collecting = false;

    constructor(private readonly cycle: (mode: KeyboardReviewMode) => void,
        private readonly release: () => void) {}

    // Legacy Option+Shift+Next/Previous owns that entire chord, including repeats and its eventual release.
    consumeStageShortcut(): void { this.consumed = true; this.shiftTap = false; this.collecting = false; this.mode = "normal"; }

    cancel(): void {
        this.mode = "normal"; this.collecting = false; this.shiftTap = false; this.blocked = true;
    }

    reset(): void { this.cancel(); this.previous = undefined; this.consumed = false; }

    sample(state: ReviewKeyState): void {
        const previous = this.previous;
        this.previous = state;
        if (!previous) {
            // A key already held as the window gains focus is never a completed Shift tap.
            this.blocked = state.shift || state.navigation;
            return;
        }
        const allUp = !state.option && !state.shift && !state.navigation;
        if (this.blocked) { if (allUp) { this.blocked = false; this.consumed = false; } return; }
        if (state.shift && !previous.shift) {
            this.shiftTap = state.option && !state.navigation;
            this.consumed = false;
        }
        if (state.navigation || state.usedShift) { this.shiftTap = false; }
        if (previous.shift && !state.shift) {
            if (state.option && this.shiftTap && !this.consumed) {
                this.mode = this.mode === "changes" ? "files" : "changes";
                this.collecting = true;
                this.cycle(this.mode);
            }
            this.shiftTap = false;
        }
        if (allUp) {
            const finish = this.collecting && !this.consumed;
            this.collecting = false; this.mode = "normal"; this.consumed = false;
            if (finish) { this.release(); }
        }
    }
}
