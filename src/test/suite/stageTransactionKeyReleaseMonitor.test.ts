import * as assert from "assert";
import { runInNewContext } from "vm";
import {
    ALLOWED_KEY_CODES,
    KEY_RELEASE_MONITOR_ARGUMENTS,
    KEY_RELEASE_MONITOR_EXECUTABLE,
    KEY_RELEASE_MONITOR_SCRIPT,
    KEY_RELEASE_REQUEST_TIMEOUT_MS,
    KEY_RELEASE_SPAWN_RETRY_MS,
    MacKeyReleaseMonitor,
    MonitorProcess,
} from "../../macKeyReleaseMonitor";
import { KeyReleaseOutcome } from "../../keyboardStageRepeatGuard";

type Listener = (...args: unknown[]) => void;

// Stand-in for the osascript child: records stdin writes and lets a test emit stdout lines or exit.
class FakeProcess implements MonitorProcess {
    readonly writes: string[] = [];
    killed = 0;
    private readonly listeners = new Map<string, Listener[]>();
    stdin = {
        write: (chunk: string) => { this.writes.push(chunk); return true; },
        on: (event: "error", listener: Listener) => this.add(`stdin:${event}`, listener),
    };
    stdout = {
        on: (event: "data", listener: (chunk: Buffer | string) => void) =>
            this.add(`stdout:${event}`, listener as Listener),
    };
    on(event: "exit" | "error", listener: Listener): void { this.add(event, listener); }
    kill(): void { this.killed++; }
    emitStdout(chunk: string): void { for (const listener of this.listeners.get("stdout:data") ?? []) { listener(chunk); } }
    emitExit(code: number | null): void { for (const listener of this.listeners.get("exit") ?? []) { listener(code); } }
    emitError(error: Error): void { for (const listener of this.listeners.get("error") ?? []) { listener(error); } }
    emitStdinError(error: Error): void { for (const listener of this.listeners.get("stdin:error") ?? []) { listener(error); } }
    private add(event: string, listener: Listener): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
}

const createMonitor = (options: { platform?: NodeJS.Platform; spawnError?: Error } = {}) => {
    const processes: FakeProcess[] = [];
    const spawnCalls: { file: string; args: readonly string[]; options: unknown }[] = [];
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let nextHandle = 1;
    let time = 5_000;
    const log: string[] = [];
    const warnings: string[] = [];
    const monitor = new MacKeyReleaseMonitor({
        platform: options.platform ?? "darwin",
        spawn: (file, args, spawnOptions) => {
            spawnCalls.push({ file, args, options: spawnOptions });
            if (options.spawnError) { throw options.spawnError; }
            const child = new FakeProcess();
            processes.push(child);
            return child;
        },
        now: () => time,
        setTimer: (callback, ms) => { const handle = nextHandle++; timers.set(handle, { callback, ms }); return handle; },
        clearTimer: handle => { timers.delete(handle as number); },
        log: message => log.push(message),
        warn: message => warnings.push(message),
    });
    const fireTimers = () => { for (const [handle, timer] of [...timers.entries()]) { timers.delete(handle); timer.callback(); } };
    const advance = (ms: number) => { time += ms; };
    return { monitor, processes, spawnCalls, timers, fireTimers, advance, log, warnings };
};

const settled = async (promise: Promise<KeyReleaseOutcome>): Promise<KeyReleaseOutcome | "pending"> => {
    return Promise.race([promise, new Promise<"pending">(resolve => setImmediate(() => resolve("pending")))]);
};

suite("macOS key-release monitor", () => {
    test("allowlists exactly the four physical stage key codes on both sides of the pipe", () => {
        assert.deepStrictEqual([...ALLOWED_KEY_CODES].sort((a, b) => a - b), [6, 7, 43, 47]);
        assert.ok(KEY_RELEASE_MONITOR_SCRIPT.includes("var allowed = [6, 7, 43, 47];"));
        assert.ok(KEY_RELEASE_MONITOR_SCRIPT.includes("CGEventSourceKeyState"));
        assert.ok(!/\$\{|`|\bsh\b|\/bin\/(?:ba)?sh|do shell script/.test(KEY_RELEASE_MONITOR_SCRIPT), "the script must never reach a shell");
        assert.strictEqual(KEY_RELEASE_MONITOR_EXECUTABLE, "/usr/bin/osascript");
        assert.deepStrictEqual([...KEY_RELEASE_MONITOR_ARGUMENTS], ["-l", "JavaScript", "-e"]);
    });

    test("spawns the hardcoded osascript JXA monitor once, shell-free, and reuses it across holds", async () => {
        const { monitor, processes, spawnCalls } = createMonitor();
        const first = monitor.watchRelease(7);
        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].file, "/usr/bin/osascript");
        assert.deepStrictEqual(spawnCalls[0].args, ["-l", "JavaScript", "-e", KEY_RELEASE_MONITOR_SCRIPT]);
        assert.deepStrictEqual(spawnCalls[0].options, { stdio: ["pipe", "pipe", "ignore"] });
        assert.deepStrictEqual(processes[0].writes, ["1 7\n"]);
        assert.strictEqual(await settled(first), "pending");
        processes[0].emitStdout("released 1\n");
        assert.strictEqual(await first, "released");

        const second = monitor.watchRelease(47);
        assert.strictEqual(spawnCalls.length, 1, "the idle child is reused, no start-up latency on later holds");
        assert.deepStrictEqual(processes[0].writes, ["1 7\n", "2 47\n"]);
        processes[0].emitStdout("released 2\n");
        assert.strictEqual(await second, "released");
        assert.strictEqual(monitor.isRunning(), true);
    });

    test("reassembles chunked stdout and matches answers by request id, never by arrival order", async () => {
        const { monitor, processes } = createMonitor();
        const a = monitor.watchRelease(6);
        const b = monitor.watchRelease(43);
        processes[0].emitStdout("relea");
        assert.strictEqual(await settled(a), "pending");
        processes[0].emitStdout("sed 2\nreleased 1\n");
        assert.strictEqual(await a, "released");
        assert.strictEqual(await b, "released");
    });

    test("timeout, rejected, invalid and unknown output never count as a release", async () => {
        const { monitor, processes, log } = createMonitor();
        const timedOut = monitor.watchRelease(7);
        const rejected = monitor.watchRelease(7);
        const stillPending = monitor.watchRelease(7);
        processes[0].emitStdout("timeout 1\nrejected 2\ninvalid\ngarbage\n");
        assert.strictEqual(await timedOut, "failed");
        assert.strictEqual(await rejected, "failed");
        assert.strictEqual(await settled(stillPending), "pending");
        assert.ok(log.some(line => line.includes("garbage")));
        processes[0].emitStdout("released 3\n");
        assert.strictEqual(await stillPending, "released");
    });

    test("an unavailable key-state API warns once and disables retries for the cooldown", async () => {
        const { monitor, processes, spawnCalls, warnings, advance } = createMonitor();
        const first = monitor.watchRelease(7);
        processes[0].emitStdout("unavailable\n");
        assert.strictEqual(await first, "failed");
        assert.strictEqual(processes[0].killed, 1);
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(await monitor.watchRelease(7), "failed");
        assert.strictEqual(spawnCalls.length, 1, "no respawn inside the cooldown");
        advance(KEY_RELEASE_SPAWN_RETRY_MS);
        const retried = monitor.watchRelease(7);
        assert.strictEqual(spawnCalls.length, 2, "after the cooldown a fresh child is tried");
        assert.deepStrictEqual(processes[1].writes, ["2 7\n"], "a refused request consumes no id");
        processes[1].emitStdout("released 2\n");
        assert.strictEqual(await retried, "released");
        assert.strictEqual(warnings.length, 1, "the warning is not repeated");
    });

    test("a child that exits on EOF fails the pending hold and is respawned for the next one", async () => {
        const { monitor, processes, spawnCalls, warnings } = createMonitor();
        const pending = monitor.watchRelease(7);
        processes[0].emitExit(0);
        assert.strictEqual(await pending, "failed");
        assert.strictEqual(monitor.isRunning(), false);
        assert.strictEqual(warnings.length, 0, "a clean exit is not a monitor failure");
        const next = monitor.watchRelease(7);
        assert.strictEqual(spawnCalls.length, 2);
        assert.deepStrictEqual(processes[1].writes, ["2 7\n"]);
        processes[1].emitStdout("released 2\n");
        assert.strictEqual(await next, "released");
    });

    test("a child that exits with an error code warns once and is not relaunched on every press", async () => {
        const { monitor, processes, spawnCalls, warnings, advance } = createMonitor();
        const pending = monitor.watchRelease(7);
        processes[0].emitExit(1);
        assert.strictEqual(await pending, "failed");
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(await monitor.watchRelease(7), "failed");
        assert.strictEqual(spawnCalls.length, 1, "inside the cooldown every hold fails fast without a spawn");
        advance(KEY_RELEASE_SPAWN_RETRY_MS);
        monitor.watchRelease(7);
        assert.strictEqual(spawnCalls.length, 2);
        assert.strictEqual(warnings.length, 1);
    });

    test("a stdin pipe error (EPIPE) is contained and fails the pending hold instead of crashing", async () => {
        const { monitor, processes } = createMonitor();
        const pending = monitor.watchRelease(7);
        processes[0].emitStdinError(new Error("EPIPE"));
        assert.strictEqual(await pending, "failed");
        assert.strictEqual(monitor.isRunning(), false);
    });

    test("a spawn error fails safely, warns once and does not retry on every press", async () => {
        const { monitor, spawnCalls, warnings } = createMonitor({ spawnError: new Error("ENOENT") });
        assert.strictEqual(await monitor.watchRelease(7), "failed");
        assert.strictEqual(await monitor.watchRelease(7), "failed");
        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(warnings.length, 1);
    });

    test("an asynchronous process error fails the pending hold and warns", async () => {
        const { monitor, processes, warnings } = createMonitor();
        const pending = monitor.watchRelease(7);
        processes[0].emitError(new Error("spawn failed"));
        assert.strictEqual(await pending, "failed");
        assert.strictEqual(warnings.length, 1);
    });

    test("a silent child times out, fails the hold and is restarted", async () => {
        const { monitor, processes, timers, fireTimers, spawnCalls } = createMonitor();
        const pending = monitor.watchRelease(7);
        assert.deepStrictEqual([...timers.values()].map(timer => timer.ms), [KEY_RELEASE_REQUEST_TIMEOUT_MS]);
        fireTimers();
        assert.strictEqual(await pending, "failed");
        assert.strictEqual(processes[0].killed, 1);
        processes[0].emitStdout("released 1\n"); // late answer from the killed child is ignored
        monitor.watchRelease(7);
        assert.strictEqual(spawnCalls.length, 2);
        assert.deepStrictEqual(processes[1].writes, ["2 7\n"]);
    });

    test("never spawns for non-allowlisted key codes, other platforms, or after dispose", async () => {
        const darwin = createMonitor();
        assert.strictEqual(await darwin.monitor.watchRelease(56), "failed"); // shift
        assert.strictEqual(await darwin.monitor.watchRelease(-1), "failed");
        assert.strictEqual(await darwin.monitor.watchRelease(Number.NaN), "failed");
        assert.strictEqual(darwin.spawnCalls.length, 0);
        for (const platform of ["linux", "win32"] as const) {
            const other = createMonitor({ platform });
            assert.strictEqual(await other.monitor.watchRelease(7), "failed");
            assert.strictEqual(other.spawnCalls.length, 0);
            assert.strictEqual(other.warnings.length, 0, "no monitor is expected off macOS, so no warning");
        }
        const disposed = createMonitor();
        const pending = disposed.monitor.watchRelease(7);
        disposed.monitor.dispose();
        assert.strictEqual(await pending, "failed");
        assert.strictEqual(disposed.processes[0].killed, 1);
        assert.strictEqual(await disposed.monitor.watchRelease(7), "failed");
        assert.strictEqual(disposed.spawnCalls.length, 1);
    });

    // The JXA source is plain JavaScript; run it against a stubbed ObjC bridge to prove the request protocol,
    // the in-script allowlist, the polling loop and EOF handling without launching osascript.
    const runScript = (options: {
        stdinChunks: string[];
        keyDownPolls: Record<number, number>; // how many polls report the key still down
        bindFunctionThrows?: boolean;
        keyStateAvailable?: boolean;
        clockStepMs?: number;
    }) => {
        const output: string[] = [];
        const polls: number[] = [];
        let now = 0;
        const remainingDown = { ...options.keyDownPolls };
        const chunks = [...options.stdinChunks];
        const sandbox = {
            ObjC: {
                import: () => undefined,
                bindFunction: () => { if (options.bindFunctionThrows) { throw new Error("no bridge"); } },
                unwrap: (value: unknown) => value,
            },
            $: {
                NSFileHandle: {
                    fileHandleWithStandardInput: { get availableData() { return chunks.length ? chunks.shift()! : ""; } },
                    fileHandleWithStandardOutput: { writeData: (data: string) => { output.push(data); } },
                },
                NSString: {
                    alloc: {
                        initWithUTF8String: (text: string) => ({ dataUsingEncoding: (encoding: number) => { assert.strictEqual(encoding, 4); return text; } }),
                        initWithDataEncoding: (data: string, encoding: number) => { assert.strictEqual(encoding, 4); return data; },
                    },
                },
                ...(options.keyStateAvailable === false ? {} : {
                    CGEventSourceKeyState: (state: number, keyCode: number) => {
                        assert.strictEqual(state, 0, "combined session state");
                        polls.push(keyCode);
                        const left = remainingDown[keyCode] ?? 0;
                        remainingDown[keyCode] = left - 1;
                        return left > 0;
                    },
                }),
            },
            delay: (seconds: number) => { assert.strictEqual(seconds, 0.01); now += options.clockStepMs ?? 10; },
            Date: { now: () => now },
        };
        runInNewContext(KEY_RELEASE_MONITOR_SCRIPT + "\nrun();", sandbox);
        return { output, polls };
    };

    test("script: answers each request by id after polling the key until it is up, then exits on EOF", () => {
        const { output, polls } = runScript({ stdinChunks: ["1 7\n", "2 4", "7\n"], keyDownPolls: { 7: 3, 47: 0 } });
        assert.deepStrictEqual(output, ["released 1\n", "released 2\n"]);
        assert.deepStrictEqual(polls, [7, 7, 7, 7, 47]);
    });

    test("script: rejects codes outside the allowlist and malformed lines without polling", () => {
        const { output, polls } = runScript({
            stdinChunks: ["3 56\n", "x 7\n", "4 7 extra\n", "5 6\n"], keyDownPolls: { 6: 0 },
        });
        assert.deepStrictEqual(output, ["rejected 3\n", "invalid\n", "invalid\n", "released 5\n"]);
        assert.deepStrictEqual(polls, [6]);
    });

    test("script: reports a timeout instead of a release when the key stays down past the polling limit", () => {
        const { output } = runScript({ stdinChunks: ["9 43\n"], keyDownPolls: { 43: Number.MAX_SAFE_INTEGER }, clockStepMs: 1000 });
        assert.deepStrictEqual(output, ["timeout 9\n"]);
    });

    test("script: survives a failed explicit binding and reports an unavailable key-state API", () => {
        const bound = runScript({ stdinChunks: ["1 7\n"], keyDownPolls: { 7: 0 }, bindFunctionThrows: true });
        assert.deepStrictEqual(bound.output, ["released 1\n"]);
        const missing = runScript({ stdinChunks: ["1 7\n"], keyDownPolls: {}, keyStateAvailable: false });
        assert.deepStrictEqual(missing.output, ["unavailable\n"]);
    });
});
