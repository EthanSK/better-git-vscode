// Ethan's "ten or so underneath": move the current Source Control review row near the top only
// when upcoming files would otherwise be below the viewport. This is presentation, never navigation,
// selection or staging. The native adapter supplies the visible file area below any sticky headers.
export interface ScmReviewViewport {
    top: number;
    bottom: number;
    rowTop: number;
    rowHeight: number;
    remainingFiles: number;
    lookahead: number;
}

// Keep this function self-contained so the native worker can use its compiled source verbatim.
// One calculation owns both unit coverage and native decisions; no separately maintained JXA copy.
export function scmReviewScrollDistance(view: ScmReviewViewport): number {
    const values = [view.top, view.bottom, view.rowTop, view.rowHeight, view.remainingFiles, view.lookahead];
    if (!values.every(Number.isFinite) || view.rowHeight <= 0 || view.bottom <= view.top
        || view.remainingFiles <= 0 || view.lookahead <= 0) { return 0; }
    // Auto Reveal owns bringing an off-screen file into view. Never scroll from stale/missing geometry.
    if (view.rowTop < view.top || view.rowTop + view.rowHeight > view.bottom) { return 0; }
    const capacity = Math.floor((view.bottom - view.top) / view.rowHeight);
    const wanted = Math.min(Math.floor(view.lookahead), Math.floor(view.remainingFiles), capacity - 1);
    if (wanted <= 0) { return 0; }
    const visibleBelow = Math.floor((view.bottom - view.rowTop - view.rowHeight) / view.rowHeight);
    if (visibleBelow >= wanted) { return 0; }
    return Math.max(0, view.rowTop - view.top);
}

// Only presentation requests may be coalesced. Every review ratchet and release still follows the
// existing ordered navigation/staging queues. This queue never gets awaited by either of them.
export class ScmReviewLookahead<T> {
    private pending: { value: T; generation: number } | undefined;
    private generation = 0;
    private running = false;
    private disposed = false;

    constructor(private readonly present: (value: T, isCurrent: () => boolean) => Promise<void>,
        private readonly cancelNative: () => void, private readonly failed: () => void) {}

    request(value: T): void {
        if (this.disposed) { return; }
        this.pending = { value, generation: ++this.generation };
        void this.drain();
    }

    cancel(): void {
        this.generation++;
        this.pending = undefined;
        this.cancelNative();
    }

    dispose(): void { this.disposed = true; this.cancel(); }

    private async drain(): Promise<void> {
        if (this.running) { return; }
        this.running = true;
        try {
            while (this.pending && !this.disposed) {
                const next = this.pending;
                this.pending = undefined;
                try { await this.present(next.value, () => !this.disposed && next.generation === this.generation); }
                catch { this.failed(); }
            }
        } finally { this.running = false; }
    }
}
