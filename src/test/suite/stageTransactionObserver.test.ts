import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StageTransactionObserver } from "../../stageTransactionObserver";
import { StageTransactionStore } from "../../stageTransactionStore";

suite("StageTransactionObserver", () => {
    let directory = "";
    let store: StageTransactionStore;
    let snapshots: Map<string, { headTree: string; indexTree: string }>;

    setup(async () => {
        directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "better-git-stage-observer-"));
        store = new StageTransactionStore(path.join(directory, "receipt.json"));
        snapshots = new Map();
    });

    teardown(async () => {
        await fs.promises.rm(directory, { recursive: true, force: true });
    });

    const observer = () => new StageTransactionObserver(store, async (repoRoot) => {
        const snapshot = snapshots.get(repoRoot);
        if (!snapshot) {
            throw new Error(`Missing snapshot for ${repoRoot}`);
        }
        return snapshot;
    });

    test("records an external index transition while HEAD is unchanged", async () => {
        const root = "/tmp/external-stage";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "after" });
        await subject.observe(root);

        const receipt = await store.load();
        assert.strictEqual(receipt?.schema, 2);
        assert.strictEqual(receipt?.kind, "observedIndexChange");
        assert.strictEqual(receipt?.repoRoot, root);
        assert.strictEqual(receipt?.headTree, "head");
        assert.strictEqual(receipt?.beforeIndexTree, "before");
        assert.strictEqual(receipt?.afterIndexTree, "after");
        assert.strictEqual(receipt?.uri, undefined);
        assert.ok(receipt?.recordedAt);
    });

    test("loads the receipt only after an already-notified transition settles", async () => {
        const root = "/tmp/external-stage-race";
        let readCount = 0;
        let releaseTransitionRead: (() => void) | undefined;
        let markTransitionReadStarted: (() => void) | undefined;
        const transitionReadStarted = new Promise<void>((resolve) => {
            markTransitionReadStarted = resolve;
        });
        const transitionReadGate = new Promise<void>((resolve) => {
            releaseTransitionRead = resolve;
        });
        const subject = new StageTransactionObserver(store, async () => {
            readCount += 1;
            if (readCount === 1) {
                return { headTree: "head", indexTree: "before" };
            }
            markTransitionReadStarted?.();
            await transitionReadGate;
            return { headTree: "head", indexTree: "after" };
        });

        await subject.prepare(root);
        subject.notify(root);
        await transitionReadStarted;

        const receiptPromise = subject.loadLatestReceipt();
        const resolvedBeforeTransition = await Promise.race([
            receiptPromise.then(() => true),
            new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
        ]);
        assert.strictEqual(resolvedBeforeTransition, false);

        releaseTransitionRead?.();
        const receipt = await receiptPromise;
        assert.strictEqual(receipt?.beforeIndexTree, "before");
        assert.strictEqual(receipt?.afterIndexTree, "after");
    });

    test("upgrades an already-observed transition with Better Git file identity", async () => {
        const root = "/tmp/better-git-stage";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "after" });
        await subject.observe(root);
        await subject.observe(root, {
            kind: "betterGitStage",
            uri: "file:///tmp/better-git-stage/file.ts",
        });

        const receipt = await store.load();
        assert.strictEqual(receipt?.kind, "betterGitStage");
        assert.strictEqual(receipt?.uri, "file:///tmp/better-git-stage/file.ts");
        assert.strictEqual(receipt?.beforeIndexTree, "before");
        assert.strictEqual(receipt?.afterIndexTree, "after");
    });

    test("a HEAD move invalidates that repository's receipt", async () => {
        const root = "/tmp/head-change";
        snapshots.set(root, { headTree: "head-1", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head-1", indexTree: "after" });
        await subject.observe(root);
        assert.ok(await store.load());

        snapshots.set(root, { headTree: "head-2", indexTree: "commit-index" });
        await subject.observe(root);
        assert.strictEqual(await store.load(), undefined);
    });

    test("a HEAD-only move invalidates the receipt even when the index tree is unchanged", async () => {
        const root = "/tmp/head-only-change";
        snapshots.set(root, { headTree: "head-1", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head-1", indexTree: "after" });
        await subject.observe(root);
        assert.ok(await store.load());

        snapshots.set(root, { headTree: "head-2", indexTree: "after" });
        await subject.observe(root);
        assert.strictEqual(await store.load(), undefined);
    });

    test("a suppressed undo updates the baseline without creating a redo receipt", async () => {
        const root = "/tmp/undo";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "after" });
        await subject.observe(root);
        assert.ok(await store.load());

        await subject.runSuppressed(root, async () => {
            snapshots.set(root, { headTree: "head", indexTree: "before" });
            subject.notify(root);
        });
        assert.strictEqual(await store.load(), undefined);

        await subject.observe(root);
        assert.strictEqual(await store.load(), undefined);
    });
});
