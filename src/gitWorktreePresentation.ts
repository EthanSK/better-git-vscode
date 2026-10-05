interface Disposable { dispose(): void; }

// One event-driven presentation for a link opened behind another app.
// Repository loading never waits for focus; a newer link or user navigation
// cancels this retry before it can change the review view.
export class DeferredWorktreePresentation implements Disposable {
    private listener?: Disposable;
    private generation = 0;
    constructor(private readonly subscribe: (listener: () => void) => Disposable,
        private readonly isFocused: () => boolean) {}

    schedule(isOwned: () => boolean, run: (isScheduled: () => boolean) => void | Promise<boolean>): void {
        this.dispose();
        const generation = this.generation;
        const isScheduled = () => generation === this.generation;
        let running = false;
        let focusRevision = 0;
        const onFocus = () => {
            focusRevision++;
            if (!this.isFocused()) { return; }
            if (running) { return; }
            if (!isScheduled() || !isOwned()) { this.clearListener(); return; }
            running = true;
            const startedRevision = focusRevision;
            const result = run(isScheduled);
            if (!result) { this.clearListener(); return; }
            void result.then(complete => {
                if (!isScheduled()) { return; }
                running = false;
                if (complete || !isOwned()) { this.clearListener(); return; }
                // A queued/running pass can lose focus. Keep the same intent alive;
                // do not spin or add a timer. A focus event during that pass is
                // also admitted once after it finishes, if the window is back.
                if (focusRevision !== startedRevision && this.isFocused()) { onFocus(); }
            }, () => { if (isScheduled()) { this.clearListener(); } });
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
