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

        const receipt = await store.loadLatest();
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

        const receipt = await store.loadLatest();
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
        assert.ok(await store.loadLatest());

        snapshots.set(root, { headTree: "head-2", indexTree: "commit-index" });
        await subject.observe(root);
        assert.strictEqual(await store.loadLatest(), undefined);
    });

    test("a HEAD-only move invalidates the receipt even when the index tree is unchanged", async () => {
        const root = "/tmp/head-only-change";
        snapshots.set(root, { headTree: "head-1", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head-1", indexTree: "after" });
        await subject.observe(root);
        assert.ok(await store.loadLatest());

        snapshots.set(root, { headTree: "head-2", indexTree: "after" });
        await subject.observe(root);
        assert.strictEqual(await store.loadLatest(), undefined);
    });

    test("a suppressed undo preserves earlier receipts without creating a redo receipt", async () => {
        const root = "/tmp/undo";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const subject = observer();
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "middle" });
        await subject.observe(root);
        snapshots.set(root, { headTree: "head", indexTree: "after" });
        await subject.observe(root);
        const latest = await store.loadLatest();
        assert.ok(latest);
        assert.strictEqual((await store.loadAll()).length, 2);

        await subject.runSuppressed(root, async () => {
            snapshots.set(root, { headTree: "head", indexTree: "middle" });
            subject.notify(root);
        });
        assert.strictEqual((await store.loadAll()).length, 2);

        await subject.removeReceipt(latest!);
        const previous = await store.loadLatest();
        assert.strictEqual(previous?.beforeIndexTree, "before");
        assert.strictEqual(previous?.afterIndexTree, "middle");

        await subject.observe(root);
        assert.deepStrictEqual(await store.loadAll(), [previous]);
    });

    test("a HEAD move invalidates only that repository's receipts", async () => {
        const firstRoot = "/tmp/head-change-a";
        const secondRoot = "/tmp/head-change-b";
        snapshots.set(firstRoot, { headTree: "head-a-1", indexTree: "before-a" });
        snapshots.set(secondRoot, { headTree: "head-b", indexTree: "before-b" });
        const subject = observer();
        await subject.prepare(firstRoot);
        await subject.prepare(secondRoot);
        snapshots.set(firstRoot, { headTree: "head-a-1", indexTree: "after-a" });
        await subject.observe(firstRoot);
        snapshots.set(secondRoot, { headTree: "head-b", indexTree: "after-b" });
        await subject.observe(secondRoot);

        snapshots.set(firstRoot, { headTree: "head-a-2", indexTree: "commit-a" });
        await subject.observe(firstRoot);

        const history = await store.loadAll();
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].repoRoot, secondRoot);
    });

    test("a second window must not record another window's undo as a new stage", async () => {
        const root = "/tmp/two-windows";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const first = observer();
        const second = observer();
        await first.prepare(root);
        await second.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "middle" });
        await first.observe(root);
        await second.observe(root);
        snapshots.set(root, { headTree: "head", indexTree: "after" });
        await first.observe(root);
        await second.observe(root);
        await first.undoLatest(async () => {
            snapshots.set(root, { headTree: "head", indexTree: "middle" });
            return "undone";
        });
        await second.observe(root);
        const history = await store.loadAll();
        assert.strictEqual(history.length, 1, "Undo must not become a redo receipt in the second window");
        assert.strictEqual(history[0].beforeIndexTree, "before");
        assert.strictEqual(history[0].afterIndexTree, "middle");
    });

    test("a delayed window uses the shared baseline for its next observed transition", async () => {
        const root = "/tmp/delayed-window";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const first = observer();
        const second = observer();
        await first.prepare(root);
        await second.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "middle" });
        await first.observe(root);
        snapshots.set(root, { headTree: "head", indexTree: "after" });
        await second.observe(root);
        const latest = (await store.loadLatest())!;
        assert.strictEqual(latest.beforeIndexTree, "middle", "A stale local baseline must not combine two stages");
        assert.strictEqual(latest.afterIndexTree, "after");
    });

    test("saves an explicit stage before background notifications emitted during add", async () => {
        const root = "/tmp/atomic-stage";
        const background = "/tmp/slow-background";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        snapshots.set(background, { headTree: "head", indexTree: "unchanged" });
        let releaseBackground!: () => void;
        const backgroundGate = new Promise<void>(resolve => { releaseBackground = resolve; });
        let blockBackground = false;
        const subject = new StageTransactionObserver(store, async repoRoot => {
            if (repoRoot === background && blockBackground) { await backgroundGate; }
            return snapshots.get(repoRoot)!;
        });
        await subject.prepare(root);
        await subject.prepare(background);
        blockBackground = true;
        const result = subject.runObservedMutation(root, async () => {
            snapshots.set(root, { headTree: "head", indexTree: "after" });
            subject.notify(background);
            subject.notify(root);
        }, { kind: "betterGitStage", uri: "file:///tmp/atomic-stage/a.ts" });
        try {
            assert.strictEqual(await result, undefined);
        } finally { releaseBackground(); }
        await subject.settled();
        assert.strictEqual((await store.loadLatest())?.afterIndexTree, "after");
        assert.strictEqual((await store.loadLatest())?.kind, "betterGitStage");
        assert.strictEqual((await store.loadAll()).length, 1, "later duplicate state events must not add a receipt");
    });

    test("keeps earlier observations ahead of an explicit mutation and Undo behind it", async () => {
        const root = "/tmp/atomic-order";
        const subject = observer();
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        await subject.prepare(root);
        snapshots.set(root, { headTree: "head", indexTree: "external" });
        subject.notify(root);
        const mutation = subject.runObservedMutation(root, async () => {
            snapshots.set(root, { headTree: "head", indexTree: "after" });
        }, { kind: "betterGitStage" });
        const latest = subject.loadLatestReceipt();
        assert.strictEqual(await mutation, undefined);
        assert.strictEqual((await latest)?.beforeIndexTree, "external");
        assert.strictEqual((await latest)?.afterIndexTree, "after");
        assert.strictEqual((await store.loadAll()).length, 2);
    });

    test("runs staging after failed preparation but does not invent an Undo receipt", async () => {
        let staged = false;
        const failure = new Error("cannot read index");
        const subject = new StageTransactionObserver(store, async () => { throw failure; });
        assert.strictEqual(await subject.runObservedMutation("/tmp/unreadable", async () => {
            staged = true;
        }, { kind: "betterGitStage" }), failure);
        assert.strictEqual(staged, true);
        assert.strictEqual(await store.loadLatest(), undefined);
    });

    test("propagates failed staging and continues accepting subsequent mutations", async () => {
        const root = "/tmp/failed-stage";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const subject = observer();
        await assert.rejects(subject.runObservedMutation(root, async () => {
            throw new Error("Git add failed");
        }, { kind: "betterGitStage" }), /Git add failed/);
        assert.strictEqual(await subject.runObservedMutation(root, async () => {
            snapshots.set(root, { headTree: "head", indexTree: "after" });
        }, { kind: "betterGitStage" }), undefined);
        assert.strictEqual((await store.loadAll()).length, 1);
    });

    test("one batch is one exact Undo, even when another window handles queued notifications", async () => {
        const root = "/tmp/atomic-batch";
        snapshots.set(root, { headTree: "head", indexTree: "before" });
        const first = observer();
        const second = observer();
        await first.prepare(root);
        await second.prepare(root);
        const uris = ["file:///tmp/atomic-batch/a.ts", "file:///tmp/atomic-batch/b.ts"];
        await first.runObservedMutation(root, async () => {
            snapshots.set(root, { headTree: "head", indexTree: "after-batch" });
            first.notify(root);
            second.notify(root);
        }, { kind: "betterGitStage", uri: uris[0], uris });
        await Promise.all([first.settled(), second.settled()]);
        assert.strictEqual((await store.loadAll()).length, 1);
        assert.deepStrictEqual((await store.loadLatest())?.uris, uris);
        await first.undoLatest(async receipt => {
            snapshots.set(root, { headTree: "head", indexTree: receipt.beforeIndexTree });
            return "undone";
        });
        await second.observe(root);
        assert.strictEqual(snapshots.get(root)?.indexTree, "before");
        assert.strictEqual((await store.loadAll()).length, 0, "the delayed window must not create a redo receipt");
    });
});
