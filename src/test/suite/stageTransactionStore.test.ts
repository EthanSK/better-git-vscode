import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StageTransactionStore, StoredStageTransaction } from "../../stageTransactionStore";

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

    test("a fresh store instance loads the prior extension host's receipt", async () => {
        const receipt: StoredStageTransaction = {
            schema: 1,
            repoRoot: "/tmp/example-worktree",
            beforeIndexTree: "before-tree",
            afterIndexTree: "after-tree",
            uri: "file:///tmp/example-worktree/file.ts",
            recordedAt: "2026-08-15T18:00:00.000Z",
        };

        await new StageTransactionStore(receiptPath).save(receipt);
        assert.deepStrictEqual(await new StageTransactionStore(receiptPath).load(), receipt);
        assert.strictEqual((await fs.promises.stat(receiptPath)).mode & 0o777, 0o600);
    });

    test("clear removes the receipt and malformed state fails closed", async () => {
        const store = new StageTransactionStore(receiptPath);
        await fs.promises.writeFile(receiptPath, "not-json", "utf8");
        assert.strictEqual(await store.load(), undefined);
        await store.clear();
        assert.strictEqual(await store.load(), undefined);
    });
});
