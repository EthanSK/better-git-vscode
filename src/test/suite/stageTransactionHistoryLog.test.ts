// Exercise the durable metadata log independently of VS Code: real files/Git, cross-window deduplication,
// unavailable path details, retention and slow I/O must not change exact Undo or block a stage.
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { StageTransactionHistoryLog } from "../../stageTransactionHistoryLog";
import { StageTransactionStore, ObservedIndexTransition } from "../../stageTransactionStore";
import { readIndexSnapshot, readStageTransactionPaths, restoreStageTransaction } from "../../gitStageUndo";

suite("StageTransactionHistoryLog", () => {
    let directory: string;
    setup(async () => { directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bg-history-")); });
    teardown(async () => { await fs.promises.rm(directory, { recursive: true, force: true }); });
    const records = async (log: StageTransactionHistoryLog) => {
        await log.settled();
        return (await fs.promises.readFile(log.filePath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    };

    test("preserves filenames, batches and action provenance without saving contents", async () => {
        const log = new StageTransactionHistoryLog(directory, async () => ["observed.ts"]);
        log.start("1.2.test");
        const names = ["space name.ts", "line\nbreak.ts", "ユニコード.ts"];
        log.stage("/repo", names);
        const rows = await records(log);
        assert.deepStrictEqual(rows.map(row => row.action), ["session-start", "better-git-stage"]);
        assert.deepStrictEqual(rows[1].paths, names);
        assert.strictEqual(rows[1].source, "better-git");
        assert.strictEqual((await fs.promises.stat(log.filePath!)).mode & 0o777, 0o600);
        assert.strictEqual((await fs.promises.stat(directory)).mode & 0o777, 0o700);
        assert.strictEqual(rows[1].contents, undefined);
    });

    test("real external stage, unstage, HEAD change and exact Undo remain distinguishable", async () => {
        const repo = path.join(directory, "repo"); await fs.promises.mkdir(repo);
        const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
        git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@local.invalid");
        await fs.promises.writeFile(path.join(repo, "space name.ts"), "base\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
        const log = new StageTransactionHistoryLog(path.join(directory, "logs"), readStageTransactionPaths);
        const receiptPath = path.join(directory, "undo.json");
        const store = new StageTransactionStore(receiptPath, change => log.observe(change));
        const otherWindow = new StageTransactionStore(receiptPath, change => log.observe(change));
        const observe = () => store.observeSnapshot(repo, () => readIndexSnapshot(repo), undefined);
        await observe(); // Baseline is not an action and cannot reconstruct earlier staging.
        await fs.promises.writeFile(path.join(repo, "space name.ts"), "changed\n"); git("add", ".");
        await observe(); await otherWindow.observeSnapshot(repo, () => readIndexSnapshot(repo), undefined);
        git("reset", "--", "space name.ts"); await observe();
        const undo = await store.consumeLatest(restoreStageTransaction);
        assert.strictEqual(undo.status, "undone"); log.undo(undo.transaction!);
        git("-c", "commit.gpgsign=false", "commit", "-m", "changed"); await observe();
        const rows = await records(log);
        assert.deepStrictEqual(rows.map(row => row.action), ["observed-index-change", "observed-index-change", "better-git-undo", "observed-head-change"]);
        assert.deepStrictEqual(rows.map(row => row.source), ["unknown", "unknown", "better-git", "unknown"]);
        assert.deepStrictEqual(rows[0].paths, ["space name.ts"]);
        assert.deepStrictEqual(rows[1].paths, ["space name.ts"]);
        assert.strictEqual(rows[2].before.indexTree, rows[1].after.indexTree);
        assert.strictEqual(rows[2].after.indexTree, rows[1].before.indexTree);
        assert.strictEqual(await store.loadLatest(), undefined, "HEAD still invalidates exact Undo");
    });

    test("slow history enrichment cannot hold the observer/Undo queue", async () => {
        let finish!: (paths: string[]) => void;
        const pendingPaths = new Promise<string[]>(resolve => { finish = resolve; });
        const log = new StageTransactionHistoryLog(directory, () => pendingPaths);
        const store = new StageTransactionStore(path.join(directory, "undo.json"), change => log.observe(change));
        const base = { headTree: "head", headCommit: "commit", indexTree: "before" };
        await store.observeSnapshot("/repo", async () => base, undefined);
        await store.observeSnapshot("/repo", async () => ({ ...base, indexTree: "after" }), undefined);
        assert.strictEqual((await store.loadLatest())?.afterIndexTree, "after", "receipt saved while history is still waiting");
        const result = await store.consumeLatest(async () => "undone");
        assert.strictEqual(result.status, "undone", "Undo never waits for the history log");
        finish(["a.ts"]); assert.strictEqual((await records(log)).length, 1);
    });

    test("unavailable Git path details retain the transition with an explicit gap", async () => {
        const log = new StageTransactionHistoryLog(directory, async () => { throw new Error("missing tree"); });
        log.observe({ repoRoot: "/repo", before: { headTree: "h", indexTree: "a" }, after: { headTree: "h", indexTree: "b" } });
        const row = (await records(log))[0];
        assert.strictEqual(row.pathsUnavailable, true); assert.strictEqual(row.paths, undefined);
        assert.strictEqual(row.source, "unknown"); assert.strictEqual(row.after.indexTree, "b");
    });

    test("daily per-host files survive restarts; cleanup touches only expired owned files", async () => {
        const old = "2026-09-01.123-abcdef.jsonl"; const recent = "2026-11-04.123-abcdef.jsonl";
        for (const file of [old, recent, "notes.txt"]) { await fs.promises.writeFile(path.join(directory, file), "retain"); }
        const now = () => new Date("2026-11-05T12:00:00Z");
        const log = new StageTransactionHistoryLog(directory, async () => [], undefined, now); log.stage("/repo", ["a"]); await log.settled();
        const nextHost = new StageTransactionHistoryLog(directory, async () => [], undefined, now); nextHost.stage("/repo", ["b"]); await nextHost.settled();
        assert.notStrictEqual(log.filePath, nextHost.filePath);
        assert.strictEqual((await records(log))[0].paths[0], "a");
        assert.strictEqual((await records(nextHost))[0].paths[0], "b");
        assert.strictEqual(fs.existsSync(path.join(directory, old)), false);
        for (const file of [recent, "notes.txt"]) { assert.strictEqual(await fs.promises.readFile(path.join(directory, file), "utf8"), "retain"); }
    });

    test("logging and callback failures never reject normal receipt operations", async () => {
        const file = path.join(directory, "not-directory"); await fs.promises.writeFile(file, "x"); const errors: unknown[] = [];
        const log = new StageTransactionHistoryLog(file, async () => [], error => errors.push(error));
        log.stage("/repo", ["a"]); await log.settled(); assert.strictEqual(errors.length, 1);
        const store = new StageTransactionStore(path.join(directory, "undo.json"), (_change: ObservedIndexTransition) => { throw new Error("logging failed"); });
        await store.observeSnapshot("/repo", async () => ({ headTree: "h", indexTree: "a" }), undefined);
        await store.observeSnapshot("/repo", async () => ({ headTree: "h", indexTree: "b" }), undefined);
        assert.strictEqual((await store.loadLatest())?.afterIndexTree, "b");
    });
});
