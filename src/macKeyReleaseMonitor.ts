import { spawn as nodeSpawn } from "child_process";
import { KeyReleaseMonitor, KeyReleaseOutcome, PHYSICAL_STAGE_KEY_CODES } from "./keyboardStageRepeatGuard";

// Exact physical key-release signal for the keyboard stage-and-advance repeat guard (macOS only).
//
// VS Code's extension API exposes no key-up event, but the window server's combined session key state is
// readable through CoreGraphics' CGEventSourceKeyState. One /usr/bin/osascript JXA child polls it. The child
// is spawned lazily on the first tagged keyboard press and then kept alive, blocked on stdin, so later holds
// pay no ~100 ms interpreter start-up: a release is observed within one 10 ms poll, which is what lets a
// fresh press immediately after a release run instead of being swallowed by a still-starting monitor. While
// idle it consumes no CPU. Requests are `<id> <keyCode>\n` lines and answers are `released <id>` /
// `timeout <id>` / `rejected <id>` lines; the id keeps a late answer from ever satisfying a newer request.
//
// Safety: the script is a hardcoded constant, the executable is an absolute path, there is no shell, and both
// sides allowlist the four virtual key codes (Z=6, X=7, comma=43, period=47). Nothing user-controlled reaches
// the child except an integer that the allowlist already validated.

export const ALLOWED_KEY_CODES: readonly number[] = Object.freeze(Object.values(PHYSICAL_STAGE_KEY_CODES));
export const KEY_RELEASE_MONITOR_EXECUTABLE = "/usr/bin/osascript";
export const KEY_RELEASE_MONITOR_ARGUMENTS: readonly string[] = Object.freeze(["-l", "JavaScript", "-e"]);
// Longer than the script's own 15 s polling limit, so a live child always answers first and a silent one is
// treated as broken and restarted.
export const KEY_RELEASE_REQUEST_TIMEOUT_MS = 20_000;
// After a spawn failure, do not retry on every press; the guard's fallback covers the interval.
export const KEY_RELEASE_SPAWN_RETRY_MS = 30_000;

// Kept free of template-literal syntax so it can also be exercised as plain JavaScript in unit tests with a
// stubbed ObjC bridge. `delay` and `ObjC`/`$` are JXA globals under osascript.
export const KEY_RELEASE_MONITOR_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
function run() {
    var input = $.NSFileHandle.fileHandleWithStandardInput;
    var output = $.NSFileHandle.fileHandleWithStandardOutput;
    var write = function (line) {
        output.writeData($.NSString.alloc.initWithUTF8String(line + '\\n').dataUsingEncoding(4));
    };
    try { ObjC.bindFunction('CGEventSourceKeyState', ['bool', ['int', 'unsigned short']]); } catch (error) {}
    var available = false;
    try { available = typeof $.CGEventSourceKeyState === 'function'; } catch (error) {}
    if (!available) { write('unavailable'); return; }
    var allowed = [6, 7, 43, 47];
    var buffer = '';
    while (true) {
        var data = input.availableData;
        if (Number(data.length) === 0) { return; }
        buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, 4));
        var newline = buffer.indexOf('\\n');
        while (newline !== -1) {
            var line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\\n');
            var match = /^([0-9]{1,9}) ([0-9]{1,3})$/.exec(line);
            if (!match) { write('invalid'); continue; }
            var id = match[1];
            var keyCode = Number(match[2]);
            if (allowed.indexOf(keyCode) === -1) { write('rejected ' + id); continue; }
            var deadline = Date.now() + 15000;
            var released = false;
            while (Date.now() < deadline) {
                if (!$.CGEventSourceKeyState(0, keyCode)) { released = true; break; }
                delay(0.01);
            }
            write((released ? 'released ' : 'timeout ') + id);
        }
    }
}
`;

// The subset of Node's ChildProcess the monitor relies on, so tests can inject a fake process.
export interface MonitorProcess {
    stdin: { write(chunk: string): unknown; on(event: "error", listener: (error: unknown) => void): unknown } | null;
    stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
    on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
    kill(): unknown;
}

export type MonitorSpawn = (
    file: string,
    args: readonly string[],
    options: { stdio: ["pipe", "pipe", "ignore"] }
) => MonitorProcess;

export interface MacKeyReleaseMonitorOptions {
    platform?: NodeJS.Platform;
    spawn?: MonitorSpawn;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    requestTimeoutMs?: number;
    log?: (message: string) => void;
    // Called at most once per monitor for a macOS failure that turns every hold into fallback mode.
    warn?: (message: string) => void;
}

interface PendingRequest {
    resolve: (outcome: KeyReleaseOutcome) => void;
    timer: unknown;
}

const defaultSpawn: MonitorSpawn = (file, args, options) => nodeSpawn(file, [...args], options) as unknown as MonitorProcess;

export class MacKeyReleaseMonitor implements KeyReleaseMonitor {
    private child: MonitorProcess | undefined;
    private stdoutBuffer = "";
    private readonly pending = new Map<number, PendingRequest>();
    private nextRequestId = 1;
    private disposed = false;
    private lastSpawnFailureAt: number | undefined;
    private warned = false;
    private readonly platform: NodeJS.Platform;
    private readonly spawn: MonitorSpawn;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly requestTimeoutMs: number;
    private readonly log: (message: string) => void;
    private readonly warn: (message: string) => void;

    constructor(options: MacKeyReleaseMonitorOptions = {}) {
        this.platform = options.platform ?? process.platform;
        this.spawn = options.spawn ?? defaultSpawn;
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
        this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.requestTimeoutMs = options.requestTimeoutMs ?? KEY_RELEASE_REQUEST_TIMEOUT_MS;
        this.log = options.log ?? (() => undefined);
        this.warn = options.warn ?? (() => undefined);
    }

    isRunning(): boolean {
        return this.child !== undefined;
    }

    watchRelease(keyCode: number): Promise<KeyReleaseOutcome> {
        if (this.disposed || this.platform !== "darwin") { return Promise.resolve("failed"); }
        if (!ALLOWED_KEY_CODES.includes(keyCode)) {
            this.log(`Refused to watch key code ${String(keyCode)}: not an allowlisted stage key.`);
            return Promise.resolve("failed");
        }
        const child = this.ensureChild();
        if (!child || !child.stdin) { return Promise.resolve("failed"); }
        return new Promise<KeyReleaseOutcome>(resolve => {
            const id = this.nextRequestId++;
            const timer = this.setTimer(() => {
                if (!this.pending.has(id)) { return; }
                this.log(`Release request ${id} timed out; restarting the monitor.`);
                this.settle(id, "failed");
                this.terminateChild(child);
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, timer });
            try {
                child.stdin?.write(`${id} ${keyCode}\n`);
            } catch (error) {
                this.log(`Could not send release request ${id}: ${String(error)}`);
                this.settle(id, "failed");
                this.terminateChild(child);
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        if (this.child) { this.terminateChild(this.child); }
    }

    private ensureChild(): MonitorProcess | undefined {
        if (this.child) { return this.child; }
        if (this.lastSpawnFailureAt !== undefined && this.now() - this.lastSpawnFailureAt < KEY_RELEASE_SPAWN_RETRY_MS) {
            return undefined;
        }
        let child: MonitorProcess;
        try {
            child = this.spawn(
                KEY_RELEASE_MONITOR_EXECUTABLE,
                [...KEY_RELEASE_MONITOR_ARGUMENTS, KEY_RELEASE_MONITOR_SCRIPT],
                { stdio: ["pipe", "pipe", "ignore"] }
            );
        } catch (error) {
            this.recordSpawnFailure(`spawn threw: ${String(error)}`);
            return undefined;
        }
        this.child = child;
        this.stdoutBuffer = "";
        child.stdout?.on("data", chunk => this.onStdout(child, chunk));
        child.stdin?.on("error", error => {
            // EPIPE on a dead child surfaces here; without a listener Node would raise it as uncaught.
            if (this.child === child) { this.log(`Monitor stdin error: ${String(error)}`); }
            this.onChildGone(child);
        });
        child.on("error", error => {
            if (this.child === child) { this.recordSpawnFailure(`process error: ${String(error)}`); }
            this.onChildGone(child);
        });
        child.on("exit", code => {
            if (this.child === child && this.pending.size > 0) {
                this.log(`Monitor exited (${String(code)}) with ${this.pending.size} request(s) pending.`);
            }
            // A script error exits non-zero on every start; apply the cooldown so that does not cost one
            // interpreter launch per key press. Exit 0 (stdin EOF) and signals (our own kill) may respawn at once.
            if (this.child === child && typeof code === "number" && code !== 0) {
                this.recordSpawnFailure(`osascript exited with code ${code}`);
            }
            this.onChildGone(child);
        });
        this.log("Started the macOS key-release monitor.");
        return child;
    }

    private recordSpawnFailure(detail: string): void {
        this.lastSpawnFailureAt = this.now();
        this.log(`Key-release monitor unavailable: ${detail}`);
        if (!this.warned) {
            this.warned = true;
            this.warn(`Better Git could not run the macOS key-release monitor (${detail}). Keyboard stage-and-advance keeps a held key to one stage using a quiet-period fallback instead.`);
        }
    }

    private onStdout(child: MonitorProcess, chunk: Buffer | string): void {
        if (this.child !== child) { return; }
        this.stdoutBuffer += String(chunk);
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline !== -1) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            newline = this.stdoutBuffer.indexOf("\n");
            const match = /^(released|timeout|rejected|invalid|unavailable)(?: (\d+))?$/.exec(line);
            if (!match) {
                this.log(`Ignored unexpected monitor output: ${line}`);
                continue;
            }
            const word = match[1];
            const idText: string | undefined = match[2];
            if (word === "unavailable") {
                this.recordSpawnFailure("CGEventSourceKeyState is not available to osascript");
                this.terminateChild(child);
                return;
            }
            if (idText === undefined) {
                this.log(`Monitor reported ${word} without a request id.`);
                continue;
            }
            const id = Number(idText);
            if (word !== "released") { this.log(`Monitor answered ${word} for request ${id}.`); }
            this.settle(id, word === "released" ? "released" : "failed");
        }
    }

    private settle(id: number, outcome: KeyReleaseOutcome): void {
        const request = this.pending.get(id);
        if (!request) { return; }
        this.pending.delete(id);
        this.clearTimer(request.timer);
        request.resolve(outcome);
    }

    private failAllPending(): void {
        for (const id of [...this.pending.keys()]) { this.settle(id, "failed"); }
    }

    private onChildGone(child: MonitorProcess): void {
        if (this.child !== child) { return; }
        this.child = undefined;
        this.stdoutBuffer = "";
        this.failAllPending();
    }

    private terminateChild(child: MonitorProcess): void {
        this.onChildGone(child);
        try { child.kill(); } catch { /* already gone */ }
    }
}
