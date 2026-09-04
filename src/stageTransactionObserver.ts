import { StageTransactionStore, StoredStageTransaction, StageUndoResult } from "./stageTransactionStore";
import { IndexSnapshot, RestoreResult } from "./gitStageUndo";

export interface StageTransactionDetails {
    kind: "betterGitStage" | "observedIndexChange";
    uri?: string;
}

/// Observes exact Git-index tree transitions instead of assuming that staging
/// always passed through a Better Git command. VS Code's built-in Git actions,
/// user keybindings, mouse shortcuts, and terminal `git add` all converge on
/// the same index file, so exact before/after tree receipts cover every route.
///
/// The observer serializes every repository through one queue because the
/// receipt store is one global, chronologically ordered undo history.
/// `HEAD` must remain unchanged across a transition: commits, checkouts, and
/// resets therefore invalidate that repository's history rather than create an
/// undo receipt.
export class StageTransactionObserver {
    private readonly baselines = new Map<string, IndexSnapshot>();
    private readonly suppressedRoots = new Set<string>();
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly store: StageTransactionStore,
        private readonly readSnapshot: (repoRoot: string) => Promise<IndexSnapshot>,
        private readonly onBackgroundError: (error: unknown) => void = () => undefined
    ) {}

    async prepare(repoRoot: string): Promise<void> {
        await this.enqueue(async () => {
            if (!this.baselines.has(repoRoot)) {
                this.baselines.set(repoRoot, await this.readSnapshot(repoRoot));
            }
        });
    }

    async observe(repoRoot: string, details?: StageTransactionDetails): Promise<void> {
        const suppressed = this.suppressedRoots.has(repoRoot);
        await this.enqueue(() => this.observeNow(repoRoot, details, suppressed));
    }

    /// Fire-and-forget entry point for vscode.git state events. Suppression is
    /// captured when the event arrives, not when its queued work later runs.
    notify(repoRoot: string): void {
        const suppressed = this.suppressedRoots.has(repoRoot);
        void this.enqueue(() => this.observeNow(repoRoot, undefined, suppressed))
            .catch(this.onBackgroundError);
    }

    settled(): Promise<void> {
        return this.queue;
    }

    /// Read the latest receipt from inside the same serialized queue used by
    /// vscode.git notifications. This is a real ordering barrier: every index
    /// transition notified before Undo is guaranteed to finish saving before
    /// the receipt is returned, without relying on a timer or retry window.
    async loadLatestReceipt(): Promise<StoredStageTransaction | undefined> {
        let receipt: StoredStageTransaction | undefined;
        await this.enqueue(async () => {
            receipt = await this.store.loadLatest();
        });
        return receipt;
    }

    /// Mutate receipt history through the observer queue as well. This keeps
    /// consumption/invalidation ordered behind already accepted Git events.
    async removeReceipt(receipt: StoredStageTransaction): Promise<void> {
        await this.enqueue(async () => {
            await this.store.remove(receipt);
        });
    }

    async discardRepositoryHistory(repoRoot: string): Promise<void> {
        await this.enqueue(async () => {
            await this.store.discardRepository(repoRoot);
        });
    }

    async undoLatest(restore: (receipt: StoredStageTransaction) => Promise<RestoreResult>): Promise<StageUndoResult> {
        let result!: StageUndoResult;
        await this.enqueue(async () => {
            result = await this.store.consumeLatest(restore);
            if (result.status === "undone" && result.transaction) {
                this.baselines.set(result.transaction.repoRoot, {
                    headTree: result.transaction.headTree,
                    headCommit: result.transaction.headCommit,
                    indexTree: result.transaction.beforeIndexTree,
                });
            }
        });
        return result;
    }

    /// Run an index mutation that must update the observer baseline without
    /// becoming a new undo receipt. This is used by the Undo command itself.
    async runSuppressed<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
        this.suppressedRoots.add(repoRoot);
        try {
            return await operation();
        } finally {
            try {
                await this.enqueue(() => this.observeNow(repoRoot, undefined, true));
            } finally {
                this.suppressedRoots.delete(repoRoot);
            }
        }
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private async observeNow(
        repoRoot: string,
        details: StageTransactionDetails | undefined,
        suppressed: boolean
    ): Promise<void> {
        const current = await this.store.observeSnapshot(
            repoRoot, () => this.readSnapshot(repoRoot), this.baselines.get(repoRoot), details, suppressed
        );
        this.baselines.set(repoRoot, current);
    }
}
