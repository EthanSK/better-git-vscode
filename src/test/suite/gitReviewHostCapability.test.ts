// Non-GUI checks for real process-bound capability receipts and activation/disposal races; run with npm test.
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { ATOMIC_EYES_BEGIN_CAPABILITY, createReviewHostCapability, parseProcessStartTimes, ReviewHostCapability } from "../../reviewHostCapability";

suite("Review host capability", () => {
    let directory: string;
    setup(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "bgv-capability-")); });
    teardown(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    const publish = (log: (message: string) => void = message => assert.fail(message), codePid = String(process.ppid)) =>
        createReviewHostCapability({ directory, extensionVersion: "1.2.147", codePid, log });
    test("normalizes the exact UTC ps representation shared with the native consumer", () => {
        const parsed = parseProcessStartTimes(" 20354 Fri Oct 30 16:22:21 2026  \n60554 Tue Nov  3 00:04:30 2026\n", [20354, 60554]);
        assert.strictEqual(parsed.get(60554), "Tue Nov 3 00:04:30 2026");
        assert.strictEqual(parsed.get(20354), "Fri Oct 30 16:22:21 2026");
    });
    test("rejects missing, duplicate, unexpected and malformed identities", () => {
        const line = "2 Tue Nov 3 00:04:30 2026\n";
        for (const response of ["", line, line + line, line + "3 invalid\n", line + "4 Tue Nov 3 00:04:30 2026\n"]) {
            assert.throws(() => parseProcessStartTimes(response, [2, 3]));
        }
    });
    test("missing Code identity fails closed without creating a receipt", async () => {
        const messages: string[] = [];
        const lease = createReviewHostCapability({ directory, extensionVersion: "1.2.147", codePid: undefined, log: message => messages.push(message) });
        await lease.ready; await lease.dispose();
        assert.ok(messages.some(message => message.includes("Missing Code process identity")));
        assert.deepStrictEqual(await fs.readdir(directory), []);
    });
    test("publishes a bounded private receipt from real live process starts and retires it", async function () {
        if (process.platform === "win32") { this.skip(); }
        const lease = publish();
        try {
            await lease.ready;
            const files = await fs.readdir(directory); assert.strictEqual(files.length, 1);
            const receiptPath = path.join(directory, files[0]);
            const raw = await fs.readFile(receiptPath, "utf8"); assert.ok(Buffer.byteLength(raw) < 4096);
            const receipt: ReviewHostCapability = JSON.parse(raw);
            assert.strictEqual(files[0], `${process.pid}-${receipt.activationId}.json`);
            assert.strictEqual(receipt.hostPid, process.pid); assert.strictEqual(receipt.codePid, process.ppid);
            assert.deepStrictEqual(receipt.capabilities, [ATOMIC_EYES_BEGIN_CAPABILITY]);
            assert.deepStrictEqual(Object.keys(receipt).sort(), ["schemaVersion", "extensionVersion", "capabilities", "activationId", "hostPid", "hostStartTime", "codePid", "codeStartTime"].sort());
            assert.strictEqual((await fs.stat(receiptPath)).mode & 0o777, 0o600);
        } finally { await lease.dispose(); }
        assert.deepStrictEqual(await fs.readdir(directory), []);
    });
    test("retiring an older activation cannot remove a newer same-PID receipt", async function () {
        if (process.platform === "win32") { this.skip(); }
        const older = publish(); await older.ready;
        const newer = publish(); await newer.ready;
        try {
            assert.strictEqual((await fs.readdir(directory)).length, 2);
            await older.dispose();
            assert.strictEqual((await fs.readdir(directory)).length, 1);
        } finally { await older.dispose(); await newer.dispose(); }
        assert.deepStrictEqual(await fs.readdir(directory), []);
    });
    test("disposal during process collection never publishes a late receipt", async function () {
        if (process.platform === "win32") { this.skip(); }
        const lease = publish(); await lease.dispose(); await lease.ready;
        assert.deepStrictEqual(await fs.readdir(directory), []);
    });
    test("prunes a killed host's receipt while preserving a live host's unrelated activation", async function () {
        if (process.platform === "win32") { this.skip(); }
        const make = async (hostPid: number) => {
            const activationId = randomUUID(), name = `${hostPid}-${activationId}.json`;
            await fs.writeFile(path.join(directory, name), JSON.stringify({ schemaVersion: 1, hostPid, activationId, capabilities: [ATOMIC_EYES_BEGIN_CAPABILITY] }));
            return name;
        };
        const dead = await make(0x7fffffff), live = await make(process.pid);
        const lease = publish();
        try {
            await lease.ready;
            const files = await fs.readdir(directory);
            assert.ok(!files.includes(dead), "closed hosts must not accumulate indefinitely");
            assert.ok(files.includes(live), "a live activation still owns its receipt");
        } finally { await lease.dispose(); }
    });
    test("a filesystem failure leaves existing data intact and does not reject activation", async function () {
        if (process.platform === "win32") { this.skip(); }
        const blocked = path.join(directory, "existing-file"); await fs.writeFile(blocked, "keep");
        const messages: string[] = [];
        const lease = createReviewHostCapability({ directory: blocked, extensionVersion: "1.2.147", codePid: String(process.ppid), log: message => messages.push(message) });
        await lease.ready; await lease.dispose();
        assert.ok(messages.length > 0); assert.strictEqual(await fs.readFile(blocked, "utf8"), "keep");
    });
});
