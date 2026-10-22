import * as assert from "assert";
import { ReviewDocumentWarmup } from "../../gitReviewWarmup";

suite("Background review document warmup", () => {
    const tick = () => new Promise<void>(resolve => setImmediate(resolve));
    test("returns immediately and coalesces pending reviews without loading stale files", async () => {
        const deferred: (() => void)[] = [];
        const warmup = new ReviewDocumentWarmup(run => deferred.push(run));
        const seen: string[] = [];
        warmup.request([async () => { seen.push("old"); }], () => true);
        warmup.request([async () => { seen.push("new"); }], () => true);
        assert.deepStrictEqual(seen, [], "request must not perform IO inline");
        assert.strictEqual(deferred.length, 1);
        deferred[0](); await tick();
        assert.deepStrictEqual(seen, ["new"]);
        warmup.dispose();
    });
    test("one slow preload never blocks caller or starts parallel speculative loaders", async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const seen: string[] = [];
        const warmup = new ReviewDocumentWarmup();
        warmup.request([async () => { seen.push("loading"); await gate; }, async () => { seen.push("stale neighbour"); }], () => true);
        await tick();
        warmup.request([async () => { seen.push("latest"); }], () => true);
        assert.deepStrictEqual(seen, ["loading"]);
        release(); await tick();
        assert.deepStrictEqual(seen, ["loading", "latest"]);
        warmup.dispose();
    });
    test("failed or invalidated preloads remain best effort and disposal stops pending IO", async () => {
        const warmup = new ReviewDocumentWarmup();
        let current = true;
        const seen: string[] = [];
        warmup.request([
            async () => { throw new Error("file was deleted"); },
            async () => { seen.push("loaded"); current = false; },
            async () => { seen.push("wrong tab"); },
        ], () => current);
        await tick();
        assert.deepStrictEqual(seen, ["loaded"]);
        warmup.request([async () => { seen.push("disposed"); }], () => true);
        warmup.dispose(); await tick();
        assert.deepStrictEqual(seen, ["loaded"]);
    });
    test("bounds each request and never retains a completed document", async () => {
        const warmup = new ReviewDocumentWarmup();
        let count = 0;
        warmup.request(Array.from({ length: 20 }, () => async () => { count++; }), () => true);
        await tick();
        assert.strictEqual(count, 4);
        warmup.dispose();
    });
});
