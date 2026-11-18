import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { GitWorktreeWindowRouter, worktreeWindowRank, WorktreeWindowRank } from "../../gitWorktreeWindow";

suite("Worktree window routing", () => {
    test("matches exact canonical paths, preferring the dedicated folder over an open Git root", async function () {
        if (process.platform === "win32") { this.skip(); }
        const directory = await fs.mkdtemp("/tmp/bgv-windows-");
        try {
            const root = await fs.realpath(directory);
            const alias = path.join(root, "alias");
            await fs.symlink(root, alias);
            assert.strictEqual(await worktreeWindowRank(root, [alias], () => [], true), 3);
            assert.strictEqual(await worktreeWindowRank(root, [alias], () => [], false), 2);
            assert.strictEqual(await worktreeWindowRank(root, [], () => [alias], true), 1);
            assert.strictEqual(await worktreeWindowRank(root, [path.dirname(root)], () => [], true), 0);
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
    });

    test("forwards only to a unique better owner in the same Code process and profile", async function () {
        if (process.platform === "win32") { this.skip(); }
        const directory = await fs.mkdtemp("/tmp/bgv-windows-");
        const root = await fs.realpath(directory);
        const routers: GitWorktreeWindowRouter[] = [];
        const accepted: string[] = [];
        const note: string[] = [];
        const create = (id: string, rank: () => WorktreeWindowRank, profile = "profile", pid = 123) => {
            const router = new GitWorktreeWindowRouter(directory, profile, pid,
                async value => value === root ? rank() : 0, async (_root, link) => {
                    accepted.push(`${id}:${link}`);
                    return true;
                }, message => note.push(message));
            routers.push(router);
            return router;
        };
        try {
            let rank: WorktreeWindowRank = 3;
            let rivalRank: WorktreeWindowRank = 0;
            const local = create("local", () => 1);
            create("owner", () => rank);
            create("rival", () => rivalRank);
            create("other-profile", () => 3, "other");
            create("other-process", () => 3, "profile", 456);
            const deadline = Date.now() + 1000;
            while ((await fs.readdir(directory)).length !== routers.length) {
                assert.ok(Date.now() < deadline, note.join("\n") || "window sockets did not start");
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.strictEqual(await local.forward(root, "owning-link", () => true), true);
            rivalRank = 3;
            assert.strictEqual(await local.forward(root, "ambiguous", () => true), false);
            rivalRank = 0;
            rank = 1;
            assert.strictEqual(await local.forward(root, "equal-to-local", () => true), false);
            rank = 3;
            assert.strictEqual(await local.forward(root, "cancelled", () => false), false);
            assert.deepStrictEqual(accepted, ["owner:owning-link"]);
        } finally {
            for (const router of routers) { router.dispose(); }
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
