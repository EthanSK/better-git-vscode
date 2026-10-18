import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stageWithDeferredReceipt } from "../../stageTransactionExecution";
import { StageTransactionObserver } from "../../stageTransactionObserver";
import { StageTransactionStore } from "../../stageTransactionStore";

suite("Stage completion and deferred Undo", () => {
    let directory: string;
    setup(async () => { directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bg-stage-flow-")); });
    teardown(async () => { await fs.promises.rm(directory, { recursive: true, force: true }); });

    const gate = () => {
        let release!: () => void;
        const promise = new Promise<void>(resolve => { release = resolve; });
        return { promise, release };
    };
    const tick = () => new Promise<void>(resolve => setImmediate(resolve));

    test("advances after staging while receipt saving remains pending", async () => {
        const receipt = gate();
        const phases: string[] = [];
        assert.strictEqual(await stageWithDeferredReceipt({
            prepareUndo: async () => { phases.push("prepare"); },
            stage: async () => { phases.push("stage"); },
            saveUndo: async () => { phases.push("receipt queued"); await receipt.promise; phases.push("saved"); },
            onUndoError: error => { throw error; },
        }), "queued");
        phases.push("advance");
        assert.deepStrictEqual(phases, ["prepare", "stage", "receipt queued", "advance"]);
        receipt.release();
        await tick();
        assert.strictEqual(phases.at(-1), "saved");
    });

    test("immediate Undo and the next stage still wait for the queued receipt", async () => {
        const store = new StageTransactionStore(path.join(directory, "history.json"));
        const receipt = gate();
        let current = { headTree: "head", indexTree: "before" };
        let reads = 0;
        const observer = new StageTransactionObserver(store, async () => {
            if (++reads === 2) { await receipt.promise; }
            return current;
        });
        await stageWithDeferredReceipt({
            prepareUndo: () => observer.prepare("root"),
            stage: async () => { current = { headTree: "head", indexTree: "after" }; },
            saveUndo: () => observer.observe("root", { kind: "betterGitStage" }),
            onUndoError: error => { throw error; },
        });
        let nextPrepared = false;
        let undoLoaded = false;
        const next = observer.prepare("root").then(() => { nextPrepared = true; });
        const undo = observer.loadLatestReceipt().then(value => { undoLoaded = true; return value; });
        await tick();
        assert.strictEqual(nextPrepared, false);
        assert.strictEqual(undoLoaded, false);
        receipt.release();
        await next;
        assert.strictEqual((await undo)?.beforeIndexTree, "before");
        assert.strictEqual((await undo)?.afterIndexTree, "after");
    });

    test("an external stage during add retains its separate Undo entry", async () => {
        const store = new StageTransactionStore(path.join(directory, "history.json"));
        let current = { headTree: "head", indexTree: "before" };
        const observer = new StageTransactionObserver(store, async () => current);
        await stageWithDeferredReceipt({
            prepareUndo: () => observer.prepare("root"),
            stage: async () => {
                current = { headTree: "head", indexTree: "external" };
                observer.notify("root");
                await observer.settled();
                current = { headTree: "head", indexTree: "ours" };
            },
            saveUndo: () => observer.observe("root", { kind: "betterGitStage" }),
            onUndoError: error => { throw error; },
        });
        await observer.settled();
        assert.deepStrictEqual((await store.loadAll()).map(r => [r.beforeIndexTree, r.afterIndexTree]),
            [["before", "external"], ["external", "ours"]]);
        await observer.undoLatest(async r => {
            current = { headTree: "head", indexTree: r.beforeIndexTree };
            return "undone";
        });
        assert.strictEqual(current.indexTree, "external", "Undo of our stage must preserve the external stage");
    });

    test("failed preparation still stages and reports the failure only after staging", async () => {
        const phases: string[] = [];
        const failure = new Error("snapshot unavailable");
        assert.strictEqual(await stageWithDeferredReceipt({
            prepareUndo: async () => { throw failure; },
            stage: async () => { phases.push("staged"); },
            saveUndo: async () => { assert.fail("must not save an invented receipt"); },
            onUndoError: error => { assert.strictEqual(error, failure); phases.push("warn"); },
        }), "unavailable");
        assert.deepStrictEqual(phases, ["staged", "warn"]);
    });

    test("a real staging failure rejects without saving a receipt or reporting success", async () => {
        await assert.rejects(stageWithDeferredReceipt({
            prepareUndo: async () => undefined,
            stage: async () => { throw new Error("Git add failed"); },
            saveUndo: async () => { assert.fail("no receipt for failed staging"); },
            onUndoError: () => { assert.fail("a Git failure is not an Undo warning"); },
        }), /Git add failed/);
    });

    test("reports a later receipt failure without delaying completed staging", async () => {
        const receipt = gate();
        const failure = new Error("receipt unavailable");
        const errors: unknown[] = [];
        await stageWithDeferredReceipt({
            prepareUndo: async () => undefined,
            stage: async () => undefined,
            saveUndo: async () => { await receipt.promise; throw failure; },
            onUndoError: error => { errors.push(error); },
        });
        assert.deepStrictEqual(errors, []);
        receipt.release();
        await tick();
        assert.deepStrictEqual(errors, [failure]);
    });
});
