interface Disposable { dispose(): void; }

// One event-driven presentation retry for a link opened behind another app.
// Repository loading never waits for focus; a newer link or user navigation
// cancels this retry before it can change the review view.
export class DeferredWorktreePresentation implements Disposable {
    private listener?: Disposable;
    private generation = 0;
    constructor(private readonly subscribe: (listener: () => void) => Disposable,
        private readonly isFocused: () => boolean) {}

    schedule(isOwned: () => boolean, run: (isScheduled: () => boolean) => void): void {
        this.dispose();
        const generation = this.generation;
        const isScheduled = () => generation === this.generation;
        const onFocus = () => {
            if (!this.isFocused()) { return; }
            this.clearListener();
            if (isScheduled() && isOwned()) { run(isScheduled); }
        };
        this.listener = this.subscribe(onFocus);
        // Focus may have arrived between the caller's check and subscription.
        onFocus();
    }

    dispose(): void {
        this.generation++;
        this.clearListener();
    }

    private clearListener(): void {
        this.listener?.dispose();
        this.listener = undefined;
    }
}
