import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { IndexSnapshot, RestoreResult, sameHead } from "./gitStageUndo";

export const STAGE_TRANSACTION_HISTORY_LIMIT = 100;

export interface StoredStageTransaction {
    schema: 2;
    id?: string;
    kind: "betterGitStage" | "observedIndexChange";
    repoRoot: string;
    headTree: string;
    headCommit?: string;
    beforeIndexTree: string;
    afterIndexTree: string;
    uri?: string;
    recordedAt: string;
}

interface StoredStageTransactionHistory {
    schema: 3;
    entries: StoredStageTransaction[];
    baselines: { repoRoot: string; snapshot: IndexSnapshot }[];
}

export interface StageUndoResult {
    status: RestoreResult | "empty";
    transaction?: StoredStageTransaction;
    remaining: StoredStageTransaction[];
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

const isStoredStageTransaction = (value: unknown): value is StoredStageTransaction => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const receipt = value as Partial<StoredStageTransaction>;
    return (
        receipt.schema === 2 &&
        (receipt.id === undefined || (typeof receipt.id === "string" && receipt.id.length > 0)) &&
        (receipt.kind === "betterGitStage" || receipt.kind === "observedIndexChange") &&
        typeof receipt.repoRoot === "string" && receipt.repoRoot.length > 0 &&
        typeof receipt.headTree === "string" &&
        (receipt.headCommit === undefined || typeof receipt.headCommit === "string") &&
        typeof receipt.beforeIndexTree === "string" && receipt.beforeIndexTree.length > 0 &&
        typeof receipt.afterIndexTree === "string" && receipt.afterIndexTree.length > 0 &&
        (receipt.uri === undefined || (typeof receipt.uri === "string" && receipt.uri.length > 0)) &&
        typeof receipt.recordedAt === "string" && receipt.recordedAt.length > 0
    );
};

const sameTransaction = (left: StoredStageTransaction, right: StoredStageTransaction): boolean => {
    if (left.id && right.id) {
        return left.id === right.id;
    }
    return (
        left.repoRoot === right.repoRoot &&
        left.headTree === right.headTree &&
        left.beforeIndexTree === right.beforeIndexTree &&
        left.afterIndexTree === right.afterIndexTree &&
        left.recordedAt === right.recordedAt
    );
};

const sameIndexTransition = (left: StoredStageTransaction, right: StoredStageTransaction): boolean =>
    left.repoRoot === right.repoRoot &&
    sameHead(left, right) &&
    left.beforeIndexTree === right.beforeIndexTree &&
    left.afterIndexTree === right.afterIndexTree;

const findLastMatchingIndex = (
    history: readonly StoredStageTransaction[],
    predicate: (receipt: StoredStageTransaction) => boolean
): number => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        if (predicate(history[index])) {
            return index;
        }
    }
    return -1;
};

/// Persists a fail-closed, bounded LIFO history of exact Git-index transitions
/// outside an extension host. The on-disk lock makes each read-modify-write
/// atomic across VS Code windows, while write-then-rename keeps the history
/// valid if an extension host exits during a save.
export class StageTransactionStore {
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly receiptPath: string) {}

    async append(receipt: StoredStageTransaction): Promise<StoredStageTransaction> {
        return this.update(async (state) => {
            const history = state.entries;
            // Multiple VS Code windows can observe the same index event. The
            // newest receipt for that repository identifies the same logical
            // transition even when another repository changed in between.
            const latestRepositoryIndex = findLastMatchingIndex(
                history,
                (candidate) => candidate.repoRoot === receipt.repoRoot
            );
            const latestRepositoryReceipt = history[latestRepositoryIndex];
            if (latestRepositoryReceipt && sameIndexTransition(latestRepositoryReceipt, receipt)) {
                const mergedReceipt: StoredStageTransaction = {
                    ...latestRepositoryReceipt,
                    kind: latestRepositoryReceipt.kind === "betterGitStage" || receipt.kind === "betterGitStage"
                        ? "betterGitStage"
                        : "observedIndexChange",
                    uri: receipt.uri ?? latestRepositoryReceipt.uri,
                };
                if (
                    mergedReceipt.kind !== latestRepositoryReceipt.kind ||
                    mergedReceipt.uri !== latestRepositoryReceipt.uri
                ) {
                    history[latestRepositoryIndex] = mergedReceipt;
                }
                this.setBaseline(state, receipt.repoRoot, {
                    headTree: receipt.headTree, headCommit: receipt.headCommit, indexTree: receipt.afterIndexTree,
                });
                return mergedReceipt;
            }

            const storedReceipt: StoredStageTransaction = {
                ...receipt,
                id: receipt.id ?? randomUUID(),
            };
            history.push(storedReceipt);
            state.entries = history.slice(-STAGE_TRANSACTION_HISTORY_LIMIT);
            this.setBaseline(state, receipt.repoRoot, {
                headTree: receipt.headTree, headCommit: receipt.headCommit, indexTree: receipt.afterIndexTree,
            });
            return storedReceipt;
        });
    }

    async loadLatest(): Promise<StoredStageTransaction | undefined> {
        return this.enqueue(() => this.withLock(async () => {
            const history = (await this.readHistory()).entries;
            return history[history.length - 1];
        }));
    }

    async loadAll(): Promise<StoredStageTransaction[]> {
        return this.enqueue(() => this.withLock(async () => (await this.readHistory()).entries));
    }

    async enrichLatestForRepository(
        repoRoot: string,
        headTree: string,
        afterIndexTree: string,
        details: Pick<StoredStageTransaction, "kind" | "uri">
    ): Promise<boolean> {
        return this.update(async (state) => {
            const history = state.entries;
            const index = findLastMatchingIndex(history, (receipt) => receipt.repoRoot === repoRoot);
            const receipt = history[index];
            if (
                !receipt ||
                receipt.headTree !== headTree ||
                receipt.afterIndexTree !== afterIndexTree
            ) {
                return false;
            }
            history[index] = {
                ...receipt,
                kind: details.kind,
                uri: details.uri ?? receipt.uri,
            };
            return true;
        });
    }

    async remove(receipt: StoredStageTransaction): Promise<boolean> {
        return this.update(async (state) => {
            const history = state.entries;
            const index = findLastMatchingIndex(history, (candidate) => sameTransaction(candidate, receipt));
            if (index < 0) {
                return false;
            }
            history.splice(index, 1);
            return true;
        });
    }

    async discardRepository(repoRoot: string): Promise<void> {
        await this.update(async (state) => {
            state.entries = state.entries.filter((receipt) => receipt.repoRoot !== repoRoot);
            state.baselines = state.baselines.filter((baseline) => baseline.repoRoot !== repoRoot);
        });
    }

    // Read Git while holding the shared history lock. A delayed window uses the
    // shared baseline, never its older local snapshot, so it cannot duplicate a
    // transition or turn another window's consumed undo into a redo receipt.
    async observeSnapshot(
        repoRoot: string,
        readSnapshot: () => Promise<IndexSnapshot>,
        fallback: IndexSnapshot | undefined,
        details?: Pick<StoredStageTransaction, "kind" | "uri">,
        suppressed = false
    ): Promise<IndexSnapshot> {
        return this.update(async (state) => {
            const current = await readSnapshot();
            const previous = state.baselines.find((entry) => entry.repoRoot === repoRoot)?.snapshot ?? fallback;
            this.setBaseline(state, repoRoot, current);
            if (!previous) {
                return current;
            }
            if (!sameHead(previous, current)) {
                state.entries = state.entries.filter((entry) => entry.repoRoot !== repoRoot);
            } else if (previous.indexTree === current.indexTree) {
                const latest = state.entries[findLastMatchingIndex(state.entries, (entry) => entry.repoRoot === repoRoot)];
                if (latest && sameHead(latest, current) && latest.afterIndexTree === current.indexTree && details) {
                    latest.kind = details.kind;
                    latest.uri = details.uri ?? latest.uri;
                }
            } else if (!suppressed) {
                state.entries.push({
                    schema: 2, id: randomUUID(), repoRoot,
                    headTree: current.headTree, headCommit: current.headCommit,
                    beforeIndexTree: previous.indexTree, afterIndexTree: current.indexTree,
                    kind: details?.kind ?? "observedIndexChange", uri: details?.uri,
                    recordedAt: new Date().toISOString(),
                });
                state.entries = state.entries.slice(-STAGE_TRANSACTION_HISTORY_LIMIT);
            }
            return current;
        });
    }

    async consumeLatest(restore: (receipt: StoredStageTransaction) => Promise<RestoreResult>): Promise<StageUndoResult> {
        return this.update(async (state) => {
            const transaction = state.entries[state.entries.length - 1];
            if (!transaction) {
                return { status: "empty", remaining: state.entries };
            }
            // The lock spans selection, Git restore, consumption and baseline
            // update. Two windows cannot restore the same receipt concurrently.
            const status = await restore(transaction);
            if (status === "undone") {
                state.entries.pop();
                this.setBaseline(state, transaction.repoRoot, {
                    headTree: transaction.headTree, headCommit: transaction.headCommit,
                    indexTree: transaction.beforeIndexTree,
                });
            } else {
                state.entries = state.entries.filter((entry) => entry.repoRoot !== transaction.repoRoot);
                state.baselines = state.baselines.filter((entry) => entry.repoRoot !== transaction.repoRoot);
            }
            return { status, transaction, remaining: state.entries };
        });
    }

    private setBaseline(state: StoredStageTransactionHistory, repoRoot: string, snapshot: IndexSnapshot): void {
        state.baselines = state.baselines.filter((entry) => entry.repoRoot !== repoRoot);
        state.baselines.push({ repoRoot, snapshot });
        state.baselines = state.baselines.slice(-STAGE_TRANSACTION_HISTORY_LIMIT);
    }

    private update<T>(operation: (state: StoredStageTransactionHistory) => Promise<T>): Promise<T> {
        return this.enqueue(() => this.withLock(async () => {
            const state = await this.readHistory();
            const before = JSON.stringify(state);
            const result = await operation(state);
            if (JSON.stringify(state) !== before) {
                await this.writeHistory(state);
            }
            return result;
        }));
    }

    async clear(): Promise<void> {
        await this.enqueue(() => this.withLock(async () => {
            await fs.promises.rm(this.receiptPath, { force: true });
        }));
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        await fs.promises.mkdir(path.dirname(this.receiptPath), { recursive: true });
        const lockPath = `${this.receiptPath}.lock`;
        const startedAt = Date.now();
        while (true) {
            try {
                await fs.promises.mkdir(lockPath);
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }
                try {
                    const lock = await fs.promises.stat(lockPath);
                    if (Date.now() - lock.mtimeMs >= STALE_LOCK_MS) {
                        await fs.promises.rmdir(lockPath);
                        continue;
                    }
                } catch (lockError) {
                    if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
                        continue;
                    }
                    throw lockError;
                }
                if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
                    throw new Error("Timed out waiting for the Better Git stage-history lock.");
                }
                await delay(LOCK_RETRY_MS);
            }
        }

        try {
            return await operation();
        } finally {
            try {
                await fs.promises.rmdir(lockPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
        }
    }

    private async readHistory(): Promise<StoredStageTransactionHistory> {
        const empty = (): StoredStageTransactionHistory => ({ schema: 3, entries: [], baselines: [] });
        try {
            const raw = await fs.promises.readFile(this.receiptPath, "utf8");
            const stored = JSON.parse(raw) as unknown;
            // v1.2.52-v1.2.57 stored one schema-2 receipt directly. Preserve it
            // as the oldest entry and migrate on the next successful mutation.
            if (isStoredStageTransaction(stored)) {
                return { schema: 3, entries: [stored], baselines: [] };
            }
            if (typeof stored !== "object" || stored === null) {
                return empty();
            }
            const history = stored as Partial<StoredStageTransactionHistory>;
            if (
                history.schema !== 3 ||
                !Array.isArray(history.entries) ||
                !history.entries.every(isStoredStageTransaction)
            ) {
                return empty();
            }
            const baselines = (Array.isArray(history.baselines) ? history.baselines : []).filter((entry) =>
                entry && typeof entry.repoRoot === "string" && entry.snapshot &&
                typeof entry.snapshot.headTree === "string" && typeof entry.snapshot.indexTree === "string" &&
                (entry.snapshot.headCommit === undefined || typeof entry.snapshot.headCommit === "string")
            );
            return { schema: 3, entries: history.entries.slice(-STAGE_TRANSACTION_HISTORY_LIMIT),
                baselines: baselines.slice(-STAGE_TRANSACTION_HISTORY_LIMIT) };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return empty();
            }
            return empty();
        }
    }

    private async writeHistory(history: StoredStageTransactionHistory): Promise<void> {
        if (history.entries.length === 0 && history.baselines.length === 0) {
            await fs.promises.rm(this.receiptPath, { force: true });
            return;
        }
        const temporaryPath = `${this.receiptPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(
                temporaryPath,
                `${JSON.stringify(history)}\n`,
                { encoding: "utf8", mode: 0o600 }
            );
            await fs.promises.rename(temporaryPath, this.receiptPath);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true });
        }
    }
}
