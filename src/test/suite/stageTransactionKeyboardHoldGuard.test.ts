import * as assert from "assert";
import {
    FALLBACK_QUIET_MS,
    KeyReleaseOutcome,
    KeyboardStageRepeatGuard,
    PHYSICAL_STAGE_KEY_CODES,
    PhysicalStageKey,
    parseKeyboardStageArgs,
} from "../../keyboardStageRepeatGuard";

// Deterministic clock + timer queue so hold windows are advanced explicitly instead of with real sleeps.
class FakeClock {
    private time = 1_000;
    private nextHandle = 1;
    private readonly timers = new Map<number, { at: number; callback: () => void }>();
    now = (): number => this.time;
    setTimer = (callback: () => void, ms: number): unknown => {
        const handle = this.nextHandle++;
        this.timers.set(handle, { at: this.time + ms, callback });
        return handle;
    };
    clearTimer = (handle: unknown): void => { this.timers.delete(handle as number); };
    pendingTimers(): number { return this.timers.size; }
    advance(ms: number): void {
        const target = this.time + ms;
        for (;;) {
            const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) { break; }
            this.timers.delete(due[0]);
            this.time = due[1].at;
            due[1].callback();
        }
        this.time = target;
    }
}

// Each watchRelease call is captured so a test can answer it (or leave it unanswered) at a chosen moment.
class FakeMonitor {
    readonly requests: { keyCode: number; resolve: (outcome: KeyReleaseOutcome) => void; reject: (error: unknown) => void }[] = [];
    throwSynchronously = false;
    watchRelease(keyCode: number): Promise<KeyReleaseOutcome> {
        if (this.throwSynchronously) { throw new Error("monitor exploded"); }
        return new Promise<KeyReleaseOutcome>((resolve, reject) => { this.requests.push({ keyCode, resolve, reject }); });
    }
}

const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

const createGuard = () => {
    const clock = new FakeClock();
    const monitor = new FakeMonitor();
    const log: string[] = [];
    const guard = new KeyboardStageRepeatGuard({
        monitor, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: message => log.push(message),
    });
    return { clock, monitor, guard, log };
};

// Replays a physical hold: the first keydown, then OS auto-repeat keydowns every `intervalMs`.
const holdAndRepeat = (
    guard: KeyboardStageRepeatGuard, clock: FakeClock, key: PhysicalStageKey, repeats: number, intervalMs = 40
): number => {
    let admitted = guard.admit(key) ? 1 : 0;
    for (let index = 0; index < repeats; index++) {
        clock.advance(intervalMs);
        if (guard.admit(key)) { admitted++; }
    }
    return admitted;
};

suite("Keyboard stage-and-advance held-key guard", () => {
    test("maps the four physical stage keys to their macOS virtual key codes", () => {
        assert.deepStrictEqual(PHYSICAL_STAGE_KEY_CODES, { z: 6, x: 7, comma: 43, period: 47 });
        assert.ok(Object.isFrozen(PHYSICAL_STAGE_KEY_CODES));
    });

    test("only the exact manifest keyboard tag is guarded; mouse, palette and F18/F19-style calls are not", () => {
        for (const key of ["x", "z", "comma", "period"] as const) {
            assert.strictEqual(parseKeyboardStageArgs({ source: "keyboard", physicalKey: key }), key);
        }
        for (const untagged of [
            undefined, null, "corsair", "razer", "keyboard", 7, { source: "corsair", direction: "next" },
            { source: "razer" }, { source: "keyboard" }, { source: "keyboard", physicalKey: "f18" },
            { source: "keyboard", physicalKey: 7 }, { physicalKey: "x" }, { source: "mouse", physicalKey: "x" },
        ]) {
            assert.strictEqual(parseKeyboardStageArgs(untagged), undefined, `must not guard ${JSON.stringify(untagged)}`);
        }
    });

    test("one continuous hold stages exactly once and the monitor is asked for that physical key", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(holdAndRepeat(guard, clock, "x", 25), 1, "auto-repeat must never stage again");
        assert.deepStrictEqual(monitor.requests.map(request => request.keyCode), [7]);
        assert.deepStrictEqual(guard.activeHold(), { key: "x", mode: "exact" });
        await flush();
        assert.strictEqual(guard.admit("x"), false, "still held: still suppressed");
    });

    test("a release followed by a fresh press runs immediately", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(holdAndRepeat(guard, clock, "period", 5), 1);
        clock.advance(20); // release detected one poll after the last repeat
        monitor.requests[0].resolve("released");
        await flush();
        assert.strictEqual(guard.activeHold(), undefined, "hold ends on the exact release signal");
        assert.strictEqual(guard.admit("period"), true, "fresh press must run with no added delay");
        assert.deepStrictEqual(monitor.requests.map(request => request.keyCode), [47, 47]);
        assert.strictEqual(guard.admit("period"), false, "the new hold guards its own repeats");
    });

    test("a quick tap is released before the next tap and both taps stage", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(guard.admit("z"), true);
        clock.advance(60);
        monitor.requests[0].resolve("released");
        await flush();
        clock.advance(90);
        assert.strictEqual(guard.admit("z"), true, "separate taps are separate holds");
        assert.strictEqual(monitor.requests.length, 2);
    });

    test("the opposite keyboard direction is suppressed during the same hold and keeps the hold alive", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(guard.admit("x"), true);
        clock.advance(40);
        assert.strictEqual(guard.admit("z"), false, "Z pressed while X is still down is not a fresh stage");
        assert.strictEqual(monitor.requests.length, 1, "no second monitor request while the first hold is open");
        // macOS moves auto-repeat to the newest key; those Z repeats still belong to the original physical hold.
        for (let index = 0; index < 60; index++) {
            clock.advance(2_000);
            assert.strictEqual(guard.admit("z"), false);
        }
        assert.deepStrictEqual(guard.activeHold(), { key: "x", mode: "exact" });
        clock.advance(10);
        monitor.requests[0].resolve("released");
        await flush();
        assert.strictEqual(guard.admit("z"), true, "after X is released the still-held Z starts its own single stage");
        assert.strictEqual(guard.admit("z"), false);
    });

    test("untagged invocations run during an active keyboard hold without touching the guard", () => {
        const { guard, monitor } = createGuard();
        assert.strictEqual(guard.admit("x"), true);
        // The command handler consults parseKeyboardStageArgs first; untagged args never reach admit().
        for (const untagged of [undefined, "corsair", { source: "razer", direction: "next" }]) {
            assert.strictEqual(parseKeyboardStageArgs(untagged), undefined);
        }
        assert.strictEqual(monitor.requests.length, 1);
        assert.deepStrictEqual(guard.activeHold(), { key: "x", mode: "exact" });
    });

    test("a failed monitor falls back to a bounded quiet period that a held key cannot outlast", async () => {
        for (const failure of ["reject", "failed", "throw"] as const) {
            const { clock, monitor, guard } = createGuard();
            monitor.throwSynchronously = failure === "throw";
            assert.strictEqual(guard.admit("x"), true, `${failure}: first press stages`);
            if (failure === "reject") { monitor.requests[0].reject(new Error("no osascript")); }
            if (failure === "failed") { monitor.requests[0].resolve("failed"); }
            await flush();
            assert.deepStrictEqual(guard.activeHold(), { key: "x", mode: "fallback" });
            // Auto-repeat keeps arriving well inside the quiet window for a long hold: still one stage.
            let admitted = 0;
            for (let index = 0; index < 100; index++) {
                clock.advance(FALLBACK_QUIET_MS - 1);
                if (guard.admit("x")) { admitted++; }
            }
            assert.strictEqual(admitted, 0, `${failure}: held repeats must not stage`);
            assert.strictEqual(guard.admit("z"), false, `${failure}: opposite key during fallback hold is suppressed`);
            // Once the key is up, repeats stop and the quiet period ends the hold; the next press is fresh.
            clock.advance(FALLBACK_QUIET_MS);
            assert.strictEqual(guard.activeHold(), undefined, `${failure}: quiet period ended the hold`);
            assert.strictEqual(guard.admit("x"), true, `${failure}: fresh press after the quiet period stages`);
        }
    });

    test("an immediate exact release permits an equally quick fresh press without a debounce", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(guard.admit("x"), true);
        monitor.requests[0].resolve("released");
        await flush();
        assert.strictEqual(guard.activeHold(), undefined);
        assert.strictEqual(guard.admit("x"), true);
        monitor.requests[1].resolve("released");
        await flush();
        assert.strictEqual(guard.activeHold(), undefined);
    });

    test("exact mode never guesses release from elapsed time", () => {
        const { clock, guard } = createGuard();
        assert.strictEqual(guard.admit("x"), true);
        clock.advance(60_000);
        assert.deepStrictEqual(guard.activeHold(), { key: "x", mode: "exact" });
        assert.strictEqual(guard.admit("x"), false, "elapsed time alone cannot turn one hold into another stage");
    });

    test("a monitor timeout reported as failure switches a long hold to fallback without a second stage", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(holdAndRepeat(guard, clock, "period", 300, 50), 1); // 15 s physical hold
        monitor.requests[0].resolve("failed"); // script polling limit reached while still down
        await flush();
        assert.deepStrictEqual(guard.activeHold(), { key: "period", mode: "fallback" });
        assert.strictEqual(holdAndRepeat(guard, clock, "period", 20, 50), 0);
        clock.advance(FALLBACK_QUIET_MS);
        assert.strictEqual(guard.admit("period"), true);
    });

    test("dispose ends the hold, clears timers and stops guarding", () => {
        const { clock, guard } = createGuard();
        assert.strictEqual(guard.admit("x"), true);
        guard.dispose();
        assert.strictEqual(guard.activeHold(), undefined);
        assert.strictEqual(clock.pendingTimers(), 0);
        assert.strictEqual(guard.admit("x"), true, "a disposed guard never blocks a command that still runs");
    });

    test("fallback timers are cleared when a hold ends", async () => {
        const { clock, monitor, guard } = createGuard();
        assert.strictEqual(guard.admit("x"), true);
        clock.advance(80);
        monitor.requests[0].resolve("released");
        await flush();
        assert.strictEqual(clock.pendingTimers(), 0);
        assert.strictEqual(guard.admit("x"), true);
        monitor.requests[1].resolve("failed");
        await flush();
        clock.advance(FALLBACK_QUIET_MS);
        assert.strictEqual(clock.pendingTimers(), 0);
    });
});
