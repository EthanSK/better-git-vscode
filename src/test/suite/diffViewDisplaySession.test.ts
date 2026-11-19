import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DiffViewDisplaySession } from "../../diffViewDisplaySession";

suite("Display layout session", () => {
    test("one profile writer protects the choice made from a second window until it reloads", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bgv-layout-session-"));
        const primary = new DiffViewDisplaySession(directory);
        const review = new DiffViewDisplaySession(directory);
        const reloaded = new DiffViewDisplaySession(directory);
        const other = new DiffViewDisplaySession(directory);
        try {
            await primary.join(false);
            await review.join(true);
            assert.deepStrictEqual(await primary.state(), { writer: true, manual: false });
            assert.strictEqual((await review.state()).writer, false, "a second window must never issue automatic writes");
            await primary.holdManualLayout();
            assert.deepStrictEqual(await primary.state(), { writer: true, manual: true });
            await other.join(false);
            assert.deepStrictEqual(await primary.state(), { writer: true, manual: true },
                "a new unfocused window cannot take over the profile writer");
            await other.focus();
            assert.deepStrictEqual(await primary.state(), { writer: true, manual: true });
            assert.strictEqual((await other.state()).writer, false);

            await review.dispose();
            await reloaded.join(true);
            assert.deepStrictEqual(await primary.state(), { writer: true, manual: false });
            assert.strictEqual((await reloaded.state()).writer, false);
        } finally {
            await Promise.all([primary.dispose(), review.dispose(), reloaded.dispose(), other.dispose()]);
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test("writer handoff preserves the manual choice while its window stays open", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bgv-layout-session-"));
        const primary = new DiffViewDisplaySession(directory);
        const review = new DiffViewDisplaySession(directory);
        try {
            await primary.join(false);
            await review.join(true);
            await primary.holdManualLayout();
            await primary.dispose();
            assert.deepStrictEqual(await review.state(), { writer: true, manual: true });
        } finally {
            await Promise.all([primary.dispose(), review.dispose()]);
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    // 1.2.172-1.2.179 rethrew EPERM, so one leftover registration disabled automatic layout in every
    // window of the profile and logged a failure every five seconds. — Claude Fable 5.2
    test("a leftover registration whose PID now belongs to another user is discarded", async function () {
        // PID 1 is launchd/init: signalling it as an ordinary user fails with EPERM. Root would succeed.
        if (process.platform === "win32" || process.getuid?.() === 0) { this.skip(); }
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bgv-layout-session-"));
        const leftover = path.join(directory, "window-1-00000000-0000-4000-8000-000000000000");
        const window = new DiffViewDisplaySession(directory);
        try {
            await fs.mkdir(leftover);
            await window.join(true);
            assert.deepStrictEqual(await window.state(), { writer: true, manual: false },
                "the only real window must still be elected");
            await assert.rejects(fs.stat(leftover), "the stale registration is removed");
        } finally {
            await window.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
