// Best-effort document warming, never a dependency of staging or navigation.
// At most one loader runs; a newer review replaces pending work between awaits.
// Ethan asked to prepare BOTH neighbours in the background, only after the current review is loaded.
// These are presentation hints: never await them in an input queue, open speculative tabs, or move fire.
export class ReviewDocumentWarmup {
    private generation = 0;
    private pending: { generation: number; tasks: (() => Promise<unknown>)[]; current: () => boolean } | undefined;
    private running = false;
    private scheduled = false;
    private disposed = false;

    constructor(private readonly defer: (run: () => void) => void = run => { setImmediate(run); }) {}

    request(tasks: (() => Promise<unknown>)[], current: () => boolean): void {
        if (this.disposed) { return; }
        const generation = ++this.generation;
        this.pending = { generation, tasks: tasks.slice(0, 4), current };
        if (!this.running && !this.scheduled) {
            this.scheduled = true;
            this.defer(() => { this.scheduled = false; void this.run(); });
        }
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.pending = undefined;
    }

    private async run(): Promise<void> {
        if (this.running || this.disposed) { return; }
        this.running = true;
        try {
            while (this.pending && !this.disposed) {
                const request = this.pending;
                this.pending = undefined;
                for (const load of request.tasks) {
                    if (this.disposed || request.generation !== this.generation || !request.current()) { break; }
                    try { await load(); } catch { /* A cold/failed warmup keeps the normal open path. */ }
                }
            }
        } finally { this.running = false; }
    }
}
