import { StageTransactionStore, StoredStageTransaction } from "./stageTransactionStore";

export interface IndexSnapshot {
    headTree: string;
    indexTree: string;
}

export interface StageTransactionDetails {
    kind: "betterGitStage" | "observedIndexChange";
    uri?: string;
}

/// Observes exact Git-index tree transitions instead of assuming that staging
/// always passed through a Better Git command. VS Code's built-in Git actions,
/// user keybindings, mouse shortcuts, and terminal `git add` all converge on
/// the same index file, so one before/after tree receipt covers every route.
///
/// The observer serializes every repository through one queue because the
/// receipt store intentionally holds only the latest transition globally.
/// `HEAD` must remain unchanged across a transition: commits, checkouts, and
/// resets therefore invalidate rather than create an undo receipt.
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
        const current = await this.readSnapshot(repoRoot);
        const previous = this.baselines.get(repoRoot);
        this.baselines.set(repoRoot, current);

        if (!previous) {
            return;
        }

        // HEAD identity is the first safety boundary, even when the index tree
        // itself did not move. A commit, checkout, or reset must invalidate the
        // old receipt immediately rather than leaving it for the Undo command
        // to discover later.
        if (previous.headTree !== current.headTree) {
            const existing = await this.store.load();
            if (existing?.repoRoot === repoRoot) {
                await this.store.clear();
            }
            return;
        }

        if (previous.indexTree === current.indexTree) {
            // A vscode.git state event may have captured the transition before
            // the originating Better Git command resumes. Upgrade that generic
            // receipt with its precise file identity instead of overwriting it.
            if (details?.kind === "betterGitStage") {
                const existing = await this.store.load();
                if (
                    existing?.repoRoot === repoRoot &&
                    existing.headTree === current.headTree &&
                    existing.afterIndexTree === current.indexTree
                ) {
                    await this.store.save({
                        ...existing,
                        kind: details.kind,
                        uri: details.uri ?? existing.uri,
                    });
                }
            }
            return;
        }

        if (suppressed) {
            const existing = await this.store.load();
            if (existing?.repoRoot === repoRoot) {
                await this.store.clear();
            }
            return;
        }

        const receipt: StoredStageTransaction = {
            schema: 2,
            kind: details?.kind ?? "observedIndexChange",
            repoRoot,
            headTree: current.headTree,
            beforeIndexTree: previous.indexTree,
            afterIndexTree: current.indexTree,
            uri: details?.uri,
            recordedAt: new Date().toISOString(),
        };
        await this.store.save(receipt);
    }
}
