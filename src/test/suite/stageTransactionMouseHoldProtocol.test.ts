import * as assert from "assert";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { MouseHoldPacket, MouseHoldProtocol, parseMouseHoldPacket } from "../../mouseHoldProtocol";
import { startMouseHoldBridge } from "../../mouseHoldBridge";

suite("Physical mouse hold transport", () => {
    const packet = (phase: MouseHoldPacket["phase"], seq = 1, id = randomUUID()): MouseHoldPacket =>
        ({ version: 1, phase, id, seq, source: "corsair", direction: "next", mode: "changes" });

    test("strict packets reject unknown sources, phases, fields and invalid sequence IDs", () => {
        const good = packet("begin");
        assert.deepStrictEqual(parseMouseHoldPacket(good), good);
        for (const changed of [{ source: "wand" }, { phase: "exec" }, { version: 2 }, { seq: 0 },
            { seq: 1.5 }, { seq: 2147483648 }, { id: "../other" }, { extra: true }]) {
            assert.strictEqual(parseMouseHoldPacket({ ...good, ...changed }), undefined);
        }
    });

    test("only focused Begin claims a window; matching lifecycle continues without focus", async () => {
        let focused = false, abandoned = 0;
        const seen: string[] = [];
        const protocol = new MouseHoldProtocol({ canBegin: () => focused,
            begin: async p => { seen.push(p.phase); }, perform: async p => { seen.push(p.phase); },
            abandon: () => { abandoned++; } });
        const begin = packet("begin");
        assert.strictEqual(protocol.receive(begin).accepted, false);
        focused = true;
        assert.strictEqual(protocol.receive(begin).accepted, true);
        focused = false;
        for (const [index, phase] of (["ready", "step", "finish"] as const).entries()) {
            assert.strictEqual(protocol.receive({ ...begin, phase, seq: index + 2 }).accepted, true);
        }
        await protocol.settled();
        assert.deepStrictEqual(seen, ["begin", "ready", "step", "finish"]);
        assert.strictEqual(abandoned, 0);
        assert.strictEqual(protocol.receive(begin).accepted, false, "retired ID cannot reopen");
    });

    test("retries, sequence gaps, other windows and changed payloads never replay commands", async () => {
        const seen: string[] = [];
        const protocol = new MouseHoldProtocol({ canBegin: () => true, begin: async p => { seen.push(p.phase); },
            perform: async p => { seen.push(p.phase); }, abandon: () => {} });
        const begin = packet("begin"), ready = { ...begin, phase: "ready" as const, seq: 2 };
        protocol.receive(begin);
        assert.strictEqual(protocol.receive({ ...ready, id: randomUUID() }).accepted, false);
        assert.strictEqual(protocol.receive({ ...ready, source: "razer" }).accepted, false);
        assert.deepStrictEqual(protocol.receive({ ...ready, seq: 3 }), { accepted: false, expectedSeq: 2 });
        assert.strictEqual(protocol.receive(ready).accepted, true);
        assert.strictEqual(protocol.receive(ready).accepted, true);
        assert.strictEqual(protocol.receive({ ...ready, mode: "files" }).accepted, false);
        assert.strictEqual(protocol.receive({ ...ready, seq: 3, phase: "finish", direction: "previous" }).accepted, false);
        await protocol.settled();
        assert.deepStrictEqual(seen, ["begin", "ready"]);
        protocol.drop();
    });

    test("heartbeats are admitted while UI is busy; expiry discards rather than commits", async () => {
        let now = 0, unblock!: () => void, abandoned = 0;
        const seen: string[] = [];
        const protocol = new MouseHoldProtocol({ canBegin: () => true,
            begin: () => new Promise<void>(resolve => { unblock = resolve; }),
            perform: async p => { seen.push(p.phase); }, abandon: () => { abandoned++; } }, () => now);
        const begin = packet("begin");
        protocol.receive(begin);
        now = 2500;
        assert.strictEqual(protocol.receive({ ...begin, phase: "heartbeat", seq: 2 }).accepted, true);
        now = 4000; protocol.expire();
        assert.strictEqual(abandoned, 0);
        now = 5501; protocol.expire();
        unblock(); await protocol.settled();
        assert.strictEqual(abandoned, 1);
        assert.deepStrictEqual(seen, []);
        assert.strictEqual(protocol.receive({ ...begin, phase: "finish", seq: 3 }).accepted, false);
    });

    test("queued wheel idle expiry uses arrival time and does not expire a physical release", async () => {
        let now = 0, unblock!: () => void;
        const seen: string[] = [];
        const protocol = new MouseHoldProtocol({ canBegin: () => true,
            begin: () => new Promise<void>(resolve => { unblock = resolve; }),
            perform: async (p, mayStart) => { if (mayStart()) { seen.push(p.phase); } }, abandon: () => {} }, () => now);
        const begin = packet("begin"); protocol.receive(begin);
        protocol.receive({ ...begin, phase: "step", seq: 2 });
        now = 400;
        protocol.receive({ ...begin, phase: "finish", seq: 3 });
        now = 10000; protocol.expire(); // release already owns the captured transaction
        unblock(); await protocol.settled();
        assert.deepStrictEqual(seen, ["finish"]);
    });

    test("abandon and bounded queue overflow invalidate pending work", async () => {
        for (const overflow of [false, true]) {
            let unblock!: () => void, abandoned = 0, performed = 0;
            const protocol = new MouseHoldProtocol({ canBegin: () => true,
                begin: () => new Promise<void>(resolve => { unblock = resolve; }),
                perform: async () => { performed++; }, abandon: () => { abandoned++; } });
            const begin = packet("begin"); protocol.receive(begin);
            if (overflow) {
                for (let seq = 2; seq <= 65; seq++) { protocol.receive({ ...begin, phase: "step", seq }); }
            } else { protocol.receive({ ...begin, phase: "abandon", seq: 2 }); }
            unblock(); await protocol.settled();
            assert.strictEqual(abandoned, 1);
            assert.strictEqual(performed, 0);
        }
    });

    test("private socket admits JSON without executing arbitrary messages", async () => {
        if (!process.getuid) { return; }
        // macOS Unix socket names have a 104-byte limit; its per-user TMPDIR is too long.
        const directory = fs.mkdtempSync("/tmp/bgv-mouse-test-");
        fs.chmodSync(directory, 0o700);
        const received: unknown[] = [];
        const bridge = startMouseHoldBridge(p => { received.push(p); return { accepted: true }; },
            () => ({ version: 1, backgroundHold: true }), directory)!;
        const send = (value: object) => new Promise<any>((resolve, reject) => {
            const socket = net.createConnection(bridge.socketPath);
            let text = "";
            socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
            socket.on("data", data => { text += data; });
            socket.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
            socket.on("error", reject);
        });
        try {
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.strictEqual(fs.statSync(bridge.socketPath).mode & 0o777, 0o600);
            assert.deepStrictEqual(await send({ version: 1, phase: "probe" }), { version: 1, backgroundHold: true });
            assert.strictEqual(received.length, 0);
            const p = packet("begin");
            assert.deepStrictEqual(await send(p), { accepted: true });
            assert.deepStrictEqual(received, [p]);
        } finally { bridge.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
    });

    test("unsafe shared and symlinked directories are rejected", () => {
        if (!process.getuid) { return; }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgv-unsafe-test-"));
        const shared = path.join(root, "shared"), link = path.join(root, "link");
        fs.mkdirSync(shared, { mode: 0o755 }); fs.symlinkSync(shared, link);
        try {
            assert.strictEqual(startMouseHoldBridge(() => ({}), () => ({}), shared), undefined);
            assert.strictEqual(startMouseHoldBridge(() => ({}), () => ({}), link), undefined);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});
