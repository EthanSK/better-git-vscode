// One cancellable focus retry for a recent explicit Worktree link; never a general app-return listener.
interface Disposable { dispose(): void; }

export const WORKTREE_PRESENTATION_MAX_AGE_MS = 10_000;
// Native expand/group-focus commands return before their renderer work; only explicit link UI uses this gap.
export const WORKTREE_TREE_SETTLE_MS = 500;
export type WorktreePresentationEndReason = "cancelled" | "newer-link" | "cursor-move" | "document-edit"
    | "review-navigation" | "expired" | "not-owned" | "completed" | "failed";

// One event-driven presentation for a link opened behind another app.
// Repository loading never waits for focus; a newer link or user navigation
// cancels this retry before it can change the review view.
// Ethan rejected re-running worktree selection whenever he returns to Code. This listener belongs only
// to one recent, unfinished link; completion/disposal removes it and later app returns have no effect.
export class DeferredWorktreePresentation implements Disposable {
    private listener?: Disposable;
    private generation = 0;
    constructor(private readonly subscribe: (listener: () => void) => Disposable,
        private readonly isFocused: () => boolean,
        private readonly now: () => number = () => performance.now(),
        private readonly onEnd: (reason: WorktreePresentationEndReason) => void = () => undefined) {}

    // The immediate foreground pass must yield to review input too, before any focus retry exists.
    checkpoint(): () => boolean {
        const generation = this.generation;
        return () => generation === this.generation;
    }

    schedule(isOwned: () => boolean, run: (isScheduled: () => boolean) => void | Promise<boolean>,
        expiresAt = this.now() + WORKTREE_PRESENTATION_MAX_AGE_MS): void {
        this.dispose();
        const generation = this.generation;
        // Check at focus and inside queued/running work. No expiry polling or delayed input.
        const isScheduled = () => generation === this.generation && this.now() < expiresAt;
        let running = false;
        let focusRevision = 0;
        const onFocus = () => {
            focusRevision++;
            if (!isScheduled()) { this.clearListener("expired"); return; }
            if (!this.isFocused()) { return; }
            if (running) { return; }
            if (!isScheduled() || !isOwned()) { this.clearListener("not-owned"); return; }
            running = true;
            const startedRevision = focusRevision;
            const result = run(isScheduled);
            if (!result) { this.clearListener("completed"); return; }
            void result.then(complete => {
                if (generation !== this.generation) { return; }
                if (!isScheduled()) { this.clearListener("expired"); return; }
                running = false;
                if (complete || !isOwned()) { this.clearListener(complete ? "completed" : "not-owned"); return; }
                // A queued/running pass can lose focus. Keep the same intent alive;
                // do not spin or add a timer. A focus event during that pass is
                // also admitted once after it finishes, if the window is back.
                if (focusRevision !== startedRevision && this.isFocused()) { onFocus(); }
            }, () => { if (generation === this.generation) { this.clearListener("failed"); } });
        };
        this.listener = this.subscribe(onFocus);
        // Focus may have arrived between the caller's check and subscription.
        onFocus();
    }

    dispose(reason: WorktreePresentationEndReason = "cancelled"): void {
        this.generation++;
        this.clearListener(reason);
    }

    private clearListener(reason: WorktreePresentationEndReason): void {
        const hadListener = !!this.listener;
        this.listener?.dispose();
        this.listener = undefined;
        if (hadListener) { this.onEnd(reason); }
    }
}
