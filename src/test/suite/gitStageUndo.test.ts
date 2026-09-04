import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readIndexSnapshot, restoreStageTransaction } from "../../gitStageUndo";
import { StoredStageTransaction } from "../../stageTransactionStore";

suite("Git stage undo safety", () => {
    let root: string;
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const write = (name: string, content: string): void => fs.writeFileSync(path.join(root, name), content);

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "better-git-undo-safety-"));
        git("init", "-q");
        git("config", "user.name", "Undo Test");
        git("config", "user.email", "undo@example.invalid");
        git("config", "commit.gpgsign", "false");
        write("a.txt", "base\n");
        git("add", "a.txt");
        git("commit", "-qm", "base");
    });
    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    const stage = async (): Promise<StoredStageTransaction> => {
        const before = await readIndexSnapshot(root);
        write("a.txt", "staged\n");
        git("add", "a.txt");
        const after = await readIndexSnapshot(root);
        return { schema: 2, kind: "observedIndexChange", repoRoot: root,
            ...after, beforeIndexTree: before.indexTree, afterIndexTree: after.indexTree,
            recordedAt: new Date().toISOString() };
    };

    test("restores the exact prior index and keeps later working-file edits", async () => {
        const receipt = await stage();
        write("a.txt", "later unsaved-on-disk work\n");
        assert.strictEqual(await restoreStageTransaction(receipt), "undone");
        assert.strictEqual(git("write-tree"), receipt.beforeIndexTree);
        assert.strictEqual(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "later unsaved-on-disk work\n");
        assert.strictEqual(fs.existsSync(path.join(root, ".git/index.lock")), false);
    });

    test("rechecks the index after a lock retry and preserves newer staged work", async () => {
        const receipt = await stage();
        const index = path.join(root, ".git/index");
        const newerIndex = path.join(root, ".git/newer-test-index");
        fs.copyFileSync(index, newerIndex);
        write("b.txt", "newer staged work\n");
        execFileSync("git", ["add", "b.txt"], { cwd: root, env: { ...process.env, GIT_INDEX_FILE: newerIndex } });
        const newerBytes = fs.readFileSync(newerIndex);
        fs.writeFileSync(`${index}.lock`, "owned by the competing Git writer", { flag: "wx" });
        const restore = restoreStageTransaction(receipt);
        // Complete that writer during the first retry delay, exactly the window
        // in which the old check-then-retry implementation overwrote its work.
        const writer = new Promise<void>((resolve) => setTimeout(() => {
            fs.renameSync(newerIndex, index);
            fs.unlinkSync(`${index}.lock`);
            resolve();
        }, 40));
        const [status] = await Promise.all([restore, writer]);
        assert.strictEqual(status, "index-changed");
        assert.deepStrictEqual(fs.readFileSync(index), newerBytes);
        assert.strictEqual(git("show", ":b.txt"), "newer staged work");
    });

    test("restores a linked worktree without changing the main worktree index", async () => {
        const mainRoot = root;
        const mainIndex = git("write-tree");
        const linked = path.join(root, "linked-test-worktree");
        git("worktree", "add", "--detach", linked);
        try {
            root = linked;
            const receipt = await stage();
            assert.strictEqual(await restoreStageTransaction(receipt), "undone");
            assert.strictEqual(git("write-tree"), receipt.beforeIndexTree);
        } finally { root = mainRoot; }
        assert.strictEqual(git("write-tree"), mainIndex);
    });

    test("restores a split index", async () => {
        git("update-index", "--split-index");
        const receipt = await stage();
        assert.strictEqual(await restoreStageTransaction(receipt), "undone");
        assert.strictEqual(git("write-tree"), receipt.beforeIndexTree);
    });

    test("restores the empty index on an unborn branch", async () => {
        git("checkout", "--orphan", "unborn-test");
        git("rm", "--cached", "a.txt");
        const receipt = await stage();
        assert.strictEqual(receipt.headCommit, "");
        assert.strictEqual(await restoreStageTransaction(receipt), "undone");
        assert.strictEqual(git("write-tree"), receipt.beforeIndexTree);
        assert.strictEqual(git("ls-files"), "");
        assert.strictEqual(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "staged\n");
    });

    test("refuses a different HEAD commit even when both commits have the same tree", async () => {
        const receipt = await stage();
        git("commit", "--allow-empty", "--only", "-qm", "empty commit while a.txt stays staged");
        assert.strictEqual(git("rev-parse", "HEAD^{tree}"), receipt.headTree);
        assert.notStrictEqual(git("rev-parse", "HEAD"), receipt.headCommit);
        const bytes = fs.readFileSync(path.join(root, ".git/index"));
        assert.strictEqual(await restoreStageTransaction(receipt), "head-changed");
        assert.deepStrictEqual(fs.readFileSync(path.join(root, ".git/index")), bytes);
    });

    test("does not remove an existing index lock when retries run out", async () => {
        const receipt = await stage();
        const lock = path.join(root, ".git/index.lock");
        fs.writeFileSync(lock, "other writer", { flag: "wx" });
        await assert.rejects(restoreStageTransaction(receipt), /File exists/);
        assert.strictEqual(fs.readFileSync(lock, "utf8"), "other writer");
    });
});
