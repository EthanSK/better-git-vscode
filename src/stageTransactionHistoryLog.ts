// Keep a readable local staging history beyond the three-entry Undo stack. extension.ts records known
// Better Git actions; StageTransactionStore supplies deduplicated observations, never guessed authorship.
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { sameHead, IndexSnapshot } from "./gitStageUndo";
import type { ObservedIndexTransition, StoredStageTransaction } from "./stageTransactionStore";

type IndexPaths = Pick<StoredStageTransaction, "repoRoot" | "beforeIndexTree" | "afterIndexTree">;
interface HistoryEvent {
    schema: 1;
    id: string;
    recordedAt: string;
    action: "session-start" | "better-git-stage" | "better-git-undo" | "observed-index-change" | "observed-head-change";
    source: "better-git" | "unknown";
    extensionVersion?: string;
    repoRoot?: string;
    paths?: readonly string[];
    before?: IndexSnapshot;
    after?: IndexSnapshot;
    undoReceiptId?: string;
    pathsUnavailable?: true;
}

export class StageTransactionHistoryLog {
    private queue: Promise<void> = Promise.resolve();
    private readonly session = `${process.pid}-${randomUUID()}`;
    private cleanedDay: string | undefined;
    private latestPath: string | undefined;

    constructor(
        readonly directory: string,
        private readonly readPaths: (change: IndexPaths) => Promise<string[]>,
        private readonly onError: (error: unknown) => void = () => undefined,
        private readonly now: () => Date = () => new Date()
    ) {}

    start(extensionVersion: string): void {
        this.record({ action: "session-start", source: "better-git", extensionVersion });
    }

    stage(repoRoot: string, paths: readonly string[]): void {
        // Ethan asked for "just a file" to settle later uncertainty. This means repo.add succeeded,
        // including a possible no-op; it does not assert every requested path changed its index entry.
        this.record({ action: "better-git-stage", source: "better-git", repoRoot, paths: [...paths] });
    }

    observe(change: ObservedIndexTransition): void {
        // A persisted baseline can predate this session. recordedAt is observation time, never proof
        // of when an external command ran; unknown authorship must survive later stage enrichment.
        this.record({
            action: sameHead(change.before, change.after) ? "observed-index-change" : "observed-head-change",
            source: "unknown", ...change,
        }, { repoRoot: change.repoRoot, beforeIndexTree: change.before.indexTree, afterIndexTree: change.after.indexTree });
    }

    undo(receipt: StoredStageTransaction): void {
        this.record({
            action: "better-git-undo", source: "better-git", repoRoot: receipt.repoRoot, undoReceiptId: receipt.id,
            before: { headTree: receipt.headTree, headCommit: receipt.headCommit, indexTree: receipt.afterIndexTree },
            after: { headTree: receipt.headTree, headCommit: receipt.headCommit, indexTree: receipt.beforeIndexTree },
        }, { repoRoot: receipt.repoRoot, beforeIndexTree: receipt.afterIndexTree, afterIndexTree: receipt.beforeIndexTree });
    }

    settled(): Promise<void> { return this.queue; }
    get filePath(): string | undefined { return this.latestPath; }

    private record(details: Omit<HistoryEvent, "schema" | "id" | "recordedAt">, transition?: IndexPaths): void {
        const event: HistoryEvent = { schema: 1, id: randomUUID(), recordedAt: this.now().toISOString(), ...details };
        // No file write, cleanup or extra Git read is awaited by stage/Undo, nor placed in their queue.
        // Read immutable before/after trees here, never the index after the user has already moved on.
        this.queue = this.queue.then(async () => {
            if (transition) {
                try { event.paths = await this.readPaths(transition); }
                catch { event.pathsUnavailable = true; }
            }
            const day = event.recordedAt.slice(0, 10);
            await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
            if (this.cleanedDay !== day) {
                this.cleanedDay = day;
                const cutoff = new Date(event.recordedAt).getTime() - 30 * 24 * 60 * 60 * 1000;
                for (const name of await fs.promises.readdir(this.directory)) {
                    if (/^\d{4}-\d{2}-\d{2}\.\d+-[a-f0-9-]+\.jsonl$/.test(name)
                        && Date.parse(name.slice(0, 10) + "T23:59:59.999Z") < cutoff) {
                        // Remove only our expired daily files; unrelated notes and current hosts survive.
                        try { await fs.promises.unlink(path.join(this.directory, name)); } catch { /* best effort */ }
                    }
                }
            }
            // One daily file per host prevents concurrent VS Code windows from interleaving large
            // batches. There is no new cross-window lock or an unbounded in-memory history cache.
            this.latestPath = path.join(this.directory, `${day}.${this.session}.jsonl`);
            await fs.promises.appendFile(this.latestPath, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
        }).catch(error => {
            try { this.onError(error); } catch { /* A diagnostic failure must never break staging. */ }
        });
    }
}
