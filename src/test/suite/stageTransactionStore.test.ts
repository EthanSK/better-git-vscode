import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    STAGE_TRANSACTION_HISTORY_LIMIT,
    StageTransactionStore,
    StoredStageTransaction,
} from "../../stageTransactionStore";

suite("StageTransactionStore", () => {
    let directory = "";
    let receiptPath = "";

    setup(async () => {
        directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "better-git-stage-receipt-"));
        receiptPath = path.join(directory, "receipt.json");
    });

    teardown(async () => {
        await fs.promises.rm(directory, { recursive: true, force: true });
    });

    const receipt = (
        sequence: number,
        repoRoot = "/tmp/example-worktree"
    ): StoredStageTransaction => ({
        schema: 2,
        kind: "observedIndexChange",
        repoRoot,
        headTree: "head-tree",
        beforeIndexTree: `tree-${sequence}`,
        afterIndexTree: `tree-${sequence + 1}`,
        recordedAt: new Date(Date.UTC(2026, 7, 15, 18, 0, 0, sequence)).toISOString(),
    });

    test("a fresh store instance loads the prior extension host's history", async () => {
        const store = new StageTransactionStore(receiptPath);
        const first = await store.append({
            ...receipt(0),
            kind: "betterGitStage",
            uri: "file:///tmp/example-worktree/file.ts",
        });
        const second = await store.append(receipt(1));

        assert.ok(first.id);
        assert.ok(second.id);
        assert.deepStrictEqual(await new StageTransactionStore(receiptPath).loadAll(), [first, second]);
        assert.deepStrictEqual(await new StageTransactionStore(receiptPath).loadLatest(), second);
        assert.strictEqual((await fs.promises.stat(receiptPath)).mode & 0o777, 0o600);
    });

    test("migrates the previous single schema-2 receipt without losing it", async () => {
        const legacyReceipt = receipt(0);
        await fs.promises.writeFile(receiptPath, `${JSON.stringify(legacyReceipt)}\n`, "utf8");
        const store = new StageTransactionStore(receiptPath);

        assert.deepStrictEqual(await store.loadLatest(), legacyReceipt);
        const next = await store.append(receipt(1));

        assert.deepStrictEqual(await store.loadAll(), [legacyReceipt, next]);
        const persisted = JSON.parse(await fs.promises.readFile(receiptPath, "utf8"));
        assert.strictEqual(persisted.schema, 3);
        assert.strictEqual(persisted.entries.length, 2);
    });

    test("caps the persistent LIFO history at exactly three entries across repositories", async () => {
        const store = new StageTransactionStore(receiptPath);
        for (let sequence = 0; sequence <= STAGE_TRANSACTION_HISTORY_LIMIT; sequence += 1) {
            await store.append(receipt(sequence, `/tmp/repo-${sequence}`));
        }

        const history = await store.loadAll();
        assert.strictEqual(STAGE_TRANSACTION_HISTORY_LIMIT, 3);
        assert.strictEqual(history.length, 3);
        assert.strictEqual(history[0].beforeIndexTree, "tree-1");
        assert.strictEqual(history[history.length - 1].afterIndexTree, "tree-4");
    });

    test("compacts an old 100-entry history on first read and does not rewrite unchanged state", async () => {
        const entries = Array.from({ length: 100 }, (_, sequence) => receipt(sequence));
        const baseline = { repoRoot: entries[0].repoRoot, snapshot: { headTree: "head-tree", indexTree: "tree-100" } };
        await fs.promises.writeFile(receiptPath, JSON.stringify({ schema: 3, entries, baselines: [baseline] }));
        const store = new StageTransactionStore(receiptPath);
        assert.deepStrictEqual(await store.loadAll(), entries.slice(-3));
        assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(receiptPath, "utf8")).entries, entries.slice(-3));
        const oldTime = new Date("2026-01-01T00:00:00Z");
        await fs.promises.utimes(receiptPath, oldTime, oldTime);
        await store.loadLatest();
        await store.observeSnapshot(baseline.repoRoot, async () => baseline.snapshot, undefined);
        assert.strictEqual((await fs.promises.stat(receiptPath)).mtimeMs, oldTime.getTime());
        for (const expected of entries.slice(-3).reverse()) {
            const result = await store.consumeLatest(async (entry) => {
                assert.deepStrictEqual(entry, expected);
                return "undone";
            });
            assert.strictEqual(result.status, "undone");
        }
        assert.strictEqual((await store.consumeLatest(async () => assert.fail("evicted receipt restored"))).status, "empty");
    });

    test("retains cross-window baselines after undo entries are evicted", async () => {
        const store = new StageTransactionStore(receiptPath);
        for (let index = 0; index < 5; index += 1) {
            await store.append(receipt(0, `/tmp/repo-${index}`));
        }
        assert.strictEqual((await store.loadAll()).length, 3);
        const before = await store.loadAll();
        await new StageTransactionStore(receiptPath).observeSnapshot("/tmp/repo-0",
            async () => ({ headTree: "head-tree", indexTree: "tree-1" }),
            { headTree: "head-tree", indexTree: "tree-0" });
        assert.deepStrictEqual(await store.loadAll(), before, "a delayed window must not revive an evicted transition");
    });

    test("serializes concurrent appends from separate extension-host stores", async () => {
        const stores = Array.from({ length: 12 }, () => new StageTransactionStore(receiptPath));
        const completed: StoredStageTransaction[] = [];
        await Promise.all(stores.map(async (store, sequence) => {
            completed.push(await store.append(receipt(sequence)));
        }));

        const history = await new StageTransactionStore(receiptPath).loadAll();
        assert.strictEqual(history.length, 3);
        assert.deepStrictEqual(history, completed.slice(-3));
    });

    test("deduplicates the same index transition observed by separate extension hosts", async () => {
        const firstStore = new StageTransactionStore(receiptPath);
        const secondStore = new StageTransactionStore(receiptPath);
        const transition = receipt(0);

        await Promise.all([
            firstStore.append(transition),
            secondStore.append({
                ...transition,
                kind: "betterGitStage",
                uri: "file:///tmp/example-worktree/file.ts",
            }),
        ]);

        const history = await new StageTransactionStore(receiptPath).loadAll();
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].kind, "betterGitStage");
        assert.strictEqual(history[0].uri, "file:///tmp/example-worktree/file.ts");
    });

    test("enriches the latest matching repository entry without reordering worktrees", async () => {
        const store = new StageTransactionStore(receiptPath);
        const first = await store.append(receipt(0, "/tmp/repo-a"));
        const otherRepo = await store.append(receipt(0, "/tmp/repo-b"));

        assert.strictEqual(await store.enrichLatestForRepository(
            first.repoRoot,
            first.headTree,
            first.afterIndexTree,
            { kind: "betterGitStage", uri: "file:///tmp/repo-a/file.ts" }
        ), true);

        const history = await store.loadAll();
        assert.strictEqual(history[0].kind, "betterGitStage");
        assert.strictEqual(history[0].uri, "file:///tmp/repo-a/file.ts");
        assert.deepStrictEqual(history[1], otherRepo);
    });

    test("removes one exact receipt and discards only one repository's history", async () => {
        const store = new StageTransactionStore(receiptPath);
        const first = await store.append(receipt(0, "/tmp/repo-a"));
        const otherRepo = await store.append(receipt(0, "/tmp/repo-b"));
        const latest = await store.append(receipt(1, "/tmp/repo-a"));

        assert.strictEqual(await store.remove(latest), true);
        assert.deepStrictEqual(await store.loadLatest(), otherRepo);
        await store.discardRepository("/tmp/repo-a");
        assert.deepStrictEqual(await store.loadAll(), [otherRepo]);
        assert.strictEqual(await store.remove(first), false);
    });

    test("clear removes the history and malformed state fails closed", async () => {
        const store = new StageTransactionStore(receiptPath);
        await fs.promises.writeFile(receiptPath, "not-json", "utf8");
        assert.strictEqual(await store.loadLatest(), undefined);
        await store.clear();
        assert.strictEqual(await store.loadLatest(), undefined);
    });

    test("legacy receipts without HEAD identity fail closed", async () => {
        await fs.promises.writeFile(
            receiptPath,
            `${JSON.stringify({
                schema: 1,
                repoRoot: "/tmp/example-worktree",
                beforeIndexTree: "before-tree",
                afterIndexTree: "after-tree",
                uri: "file:///tmp/example-worktree/file.ts",
                recordedAt: "2026-08-15T18:00:00.000Z",
            })}\n`,
            "utf8"
        );
        assert.strictEqual(await new StageTransactionStore(receiptPath).loadLatest(), undefined);
    });

    test("concurrent windows consume distinct entries and a restarted observer does not record redo", async () => {
        const first = new StageTransactionStore(receiptPath);
        const second = new StageTransactionStore(receiptPath);
        await first.append(receipt(0));
        await first.append(receipt(1));
        let indexTree = "tree-2";
        const restore = async (entry: StoredStageTransaction): Promise<"undone"> => {
            assert.strictEqual(indexTree, entry.afterIndexTree);
            await new Promise((resolve) => setImmediate(resolve));
            indexTree = entry.beforeIndexTree;
            return "undone";
        };
        await Promise.all([first.consumeLatest(restore), second.consumeLatest(restore)]);
        assert.strictEqual(indexTree, "tree-0");
        const restarted = new StageTransactionStore(receiptPath);
        await restarted.observeSnapshot("/tmp/example-worktree",
            async () => ({ headTree: "head-tree", indexTree }),
            { headTree: "head-tree", indexTree: "tree-2" });
        assert.deepStrictEqual(await restarted.loadAll(), []);
    });
});
