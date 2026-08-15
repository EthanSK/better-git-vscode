import * as assert from "assert";
import { isTransientGitIndexLockError, runWithTransientGitIndexRetry } from "../../gitIndexRetry";

suite("Git index retry", () => {
    test("retries a bounded transient index lock and then succeeds", async () => {
        let attempts = 0;
        const waits: number[] = [];
        const result = await runWithTransientGitIndexRetry(
            async () => {
                attempts += 1;
                if (attempts < 3) {
                    const error = new Error("fatal: Unable to create '/tmp/repo/.git/index.lock': File exists.");
                    throw error;
                }
                return "tree";
            },
            async (milliseconds) => { waits.push(milliseconds); },
            6
        );

        assert.strictEqual(result, "tree");
        assert.strictEqual(attempts, 3);
        assert.deepStrictEqual(waits, [80, 160]);
    });

    test("never retries unrelated git failures", async () => {
        let attempts = 0;
        await assert.rejects(
            runWithTransientGitIndexRetry(async () => {
                attempts += 1;
                throw new Error("fatal: not a git repository");
            }, async () => undefined),
            /not a git repository/
        );
        assert.strictEqual(attempts, 1);
    });

    test("stops after the configured index-lock attempt bound", async () => {
        let attempts = 0;
        const error = Object.assign(new Error("git write-tree failed"), {
            stderr: "fatal: Unable to create '.git/index.lock': File exists.",
        });
        await assert.rejects(
            runWithTransientGitIndexRetry(async () => {
                attempts += 1;
                throw error;
            }, async () => undefined, 3),
            /git write-tree failed/
        );
        assert.strictEqual(attempts, 3);
        assert.ok(isTransientGitIndexLockError(error));
    });
});
