// Viewport planning and a replaceable presentation queue for macScmReviewLookahead.ts.
// Ethan's "ten or so underneath": move the current Source Control review row only
// when upcoming files would otherwise be below the viewport, keeping context above it too.
// This is presentation, never navigation,
// selection or staging. The native adapter supplies the visible file area below any sticky headers.
export interface ScmReviewViewport {
    top: number;
    bottom: number;
    rowTop: number;
    rowHeight: number;
    remainingFiles: number;
    lookahead: number;
}

// The TypeScript coordinator owns this calculation for every native measurement. Keep it pure
// and standalone for direct and serialized tests; the native worker never duplicates these rules.
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
    // Ethan wants about ten file rows above the current file after the jump (2026-11-05),
    // not a top-aligned row. Short panes keep as much context as fits without sacrificing
    // the upcoming rows that caused this scroll. The same planner owns normal, eyes and
    // explosion/file-mode presentation; none of these modes may change the staging set.
    const contextRowsAbove = Math.min(10, Math.max(0, capacity - wanted - 1));
    return Math.max(0, view.rowTop - view.top - contextRowsAbove * view.rowHeight);
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
