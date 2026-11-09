// Modifier-mode and native physical-key protocol checks; pacing must preserve Shift-release and batch release.
import * as assert from "assert";
import { EventEmitter } from "events";
import * as vm from "vm";
import { KeyboardReviewGesture, KeyboardReviewMode, ReviewKeyState } from "../../keyboardReviewGesture";
import { MacReviewKeyMonitor, parseReviewKeyState, REVIEW_KEY_MONITOR_SCRIPT } from "../../macReviewKeyMonitor";
import { MonitorProcess } from "../../macKeyReleaseMonitor";

const keys = (option = false, shift = false, navigation = false, usedShift = false): ReviewKeyState =>
    ({ option, shift, navigation, usedShift });
const create = () => {
    const events: string[] = [];
    const gesture = new KeyboardReviewGesture(mode => events.push(mode), () => events.push("finish"));
    gesture.sample(keys());
    const tap = () => { gesture.sample(keys(true, true)); gesture.sample(keys(true)); };
    return { gesture, events, tap };
};

suite("Keyboard modifier cycle and release", () => {
    test("enters eyes then alternates eyes/files only on Shift release", () => {
        const { gesture, events, tap } = create();
        gesture.sample(keys(true)); gesture.sample(keys(true, true));
        assert.deepStrictEqual(events, []);
        gesture.sample(keys(true)); tap(); tap(); tap();
        assert.deepStrictEqual(events, ["changes", "files", "changes", "files"]);
        gesture.sample(keys()); gesture.sample(keys());
        assert.deepStrictEqual(events, ["changes", "files", "changes", "files", "finish"]);
    });
    test("Shift alone and Option release during a Shift tap never cycle", () => {
        const { gesture, events } = create();
        gesture.sample(keys(false, true)); gesture.sample(keys());
        gesture.sample(keys(true, true)); gesture.sample(keys(false, true)); gesture.sample(keys());
        assert.deepStrictEqual(events, []);
    });
    test("waits for Shift and navigation release even when Option is released first", () => {
        const { gesture, events, tap } = create(); tap();
        gesture.sample(keys(true, true, true)); gesture.sample(keys(false, true, true));
        gesture.sample(keys(false, false, true));
        assert.deepStrictEqual(events, ["changes"]);
        gesture.sample(keys()); assert.deepStrictEqual(events, ["changes", "finish"]);
    });
    test("legacy stage shortcut consumes the tap, pending batch and its final release", () => {
        const { gesture, events, tap } = create(); tap();
        gesture.sample(keys(true, true)); gesture.consumeStageShortcut();
        gesture.sample(keys(true, true, true)); gesture.sample(keys(true, false, false, true));
        gesture.sample(keys()); assert.deepStrictEqual(events, ["changes"]);
        tap(); gesture.sample(keys()); assert.deepStrictEqual(events, ["changes", "changes", "finish"]);
    });
    test("native chord evidence suppresses a tap before its VS Code command arrives", () => {
        const { gesture, events } = create();
        gesture.sample(keys(true, true)); gesture.sample(keys(true, false, false, true));
        gesture.sample(keys()); assert.deepStrictEqual(events, []);
    });
    test("Escape and focus reset suppress stale release and held-on-focus Shift", () => {
        const { gesture, events, tap } = create(); tap(); gesture.cancel(); gesture.sample(keys());
        assert.deepStrictEqual(events, ["changes"]);
        gesture.reset(); gesture.sample(keys(true, true)); gesture.sample(keys(true)); gesture.sample(keys());
        assert.deepStrictEqual(events, ["changes"]);
        tap(); gesture.sample(keys()); assert.deepStrictEqual(events, ["changes", "changes", "finish"]);
    });
    test("focus with Option already held permits a later fresh Shift tap", () => {
        const events: string[] = [];
        const gesture = new KeyboardReviewGesture(mode => events.push(mode), () => events.push("finish"));
        gesture.sample(keys(true)); gesture.sample(keys(true, true)); gesture.sample(keys(true));
        gesture.sample(keys()); assert.deepStrictEqual(events, ["changes", "finish"]);
    });
    test("starts in eyes after a rejected or retired begin without requiring Option release", () => {
        const events: string[] = [];
        let ownedMode: KeyboardReviewMode = "normal";
        let rejectBegin = true;
        const gesture = new KeyboardReviewGesture(mode => {
            events.push(mode);
            if (!rejectBegin) { ownedMode = mode; }
        }, () => events.push("finish"), () => ownedMode);
        const tap = () => { gesture.sample(keys(true, true)); gesture.sample(keys(true)); };
        gesture.sample(keys()); tap(); // No unstaged file or another input still owns the hold.
        rejectBegin = false; tap(); tap();
        ownedMode = "normal"; // The real review was retired while Option stayed held.
        tap(); gesture.sample(keys());
        assert.deepStrictEqual(events, ["changes", "changes", "files", "changes", "finish"]);
    });
    test("parses only the bounded state protocol", () => {
        assert.deepStrictEqual(parseReviewKeyState("state 1 0 1 0"), keys(true, false, true));
        assert.deepStrictEqual(parseReviewKeyState("state 1 0 1 0 2"), { ...keys(true, false, true), navigationKeys: 2 });
        assert.strictEqual(parseReviewKeyState("state 1 0 0 0 2"), undefined);
        assert.strictEqual(parseReviewKeyState("state 1 0 1 0 16"), undefined);
        for (const value of ["state 1 0", "state 2 0 0 0", "state 1 0 0 0 extra", "released 2", ""]) {
            assert.strictEqual(parseReviewKeyState(value), undefined);
        }
    });
    test("native sampler tracks a navigation key after both modifiers are released", () => {
        const frames = [new Set([58]), new Set([58, 56]), new Set([58, 56, 7]), new Set([7]), new Set<number>()];
        let frame = 0; const output: string[] = []; const stop = new Error("end");
        const dollar: any = {
            CGEventSourceKeyState: (_: number, key: number) => frames[frame].has(key), getppid: () => 123,
            CGEventSourceCounterForEventType: () => frame >= 2 ? 1 : 0,
            NSFileHandle: { fileHandleWithStandardOutput: { writeData: (data: string) => output.push(data) } },
            NSString: { alloc: { initWithUTF8String: (line: string) => ({ dataUsingEncoding: () => line }) } },
        };
        const scope: any = { $: dollar, ObjC: { import: () => undefined, bindFunction: () => undefined },
            delay: () => { if (++frame === frames.length) { throw stop; } } };
        vm.createContext(scope); vm.runInContext(REVIEW_KEY_MONITOR_SCRIPT, scope);
        assert.throws(() => scope.run(["123"]), error => error === stop);
        assert.ok(output.includes("state 0 0 1 1 2\n"));
        assert.strictEqual(output.at(-1), "state 0 0 0 0 0\n");
    });
    test("monitor kills only its child on blur/dispose, ignores late output and cancels on malformed output", () => {
        const children: (EventEmitter & { stdout: EventEmitter; kills: number })[] = [];
        const events: ReviewKeyState[] = []; let resets = 0;
        const monitor = new MacReviewKeyMonitor(state => events.push(state), () => resets++, () => undefined, {
            platform: "darwin", spawn: () => {
                const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kills: 0,
                    kill() { this.kills++; } }); children.push(child); return child as unknown as MonitorProcess;
            },
        });
        monitor.focus(true); children[0].stdout.emit("data", "state 1 0 0 0\n");
        assert.strictEqual(events.length, 1);
        monitor.focus(false); assert.strictEqual(children[0].kills, 1);
        children[0].stdout.emit("data", "state 0 0 0 0\n"); assert.strictEqual(events.length, 1);
        monitor.focus(true); children[1].stdout.emit("data", "bad\n"); assert.strictEqual(children[1].kills, 1);
        monitor.dispose(); monitor.focus(true); assert.strictEqual(children.length, 2); assert.ok(resets >= 3);
    });
    test("same-focus idle notifications preserve the Shift tap and unfinished review", () => {
        const children: (EventEmitter & { stdout: EventEmitter; kills: number })[] = [];
        const events: string[] = []; let resets = 0;
        const gesture = new KeyboardReviewGesture(mode => events.push(mode), () => events.push("finish"));
        const monitor = new MacReviewKeyMonitor(state => gesture.sample(state), () => {
            resets++; gesture.reset();
        }, () => undefined, { platform: "darwin", spawn: () => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kills: 0,
                kill() { this.kills++; } }); children.push(child); return child as unknown as MonitorProcess;
        } });
        monitor.focus(true);
        children[0].stdout.emit("data", "state 0 0 0 0\nstate 1 0 0 0\nstate 1 1 0 0\n");
        monitor.focus(true); // Activity resumes while Shift is down; focus itself never changed.
        children[0].stdout.emit("data", "state 1 0 0 0\n");
        assert.deepStrictEqual(events, ["changes"]);
        monitor.focus(true); // Becoming idle during review must not cancel its pending set either.
        children[0].stdout.emit("data", "state 0 0 0 0\n");
        assert.deepStrictEqual(events, ["changes", "finish"]);
        assert.strictEqual(children.length, 1); assert.strictEqual(resets, 1);
        monitor.focus(false); monitor.focus(false);
        assert.strictEqual(children[0].kills, 1); assert.strictEqual(resets, 2);
        monitor.dispose();
    });
    test("a stopped reader can restart on a same-focus event and rejects its predecessor's late output", () => {
        const children: (EventEmitter & { stdout: EventEmitter; kills: number })[] = [];
        const states: ReviewKeyState[] = []; const logs: string[] = [];
        const monitor = new MacReviewKeyMonitor(state => states.push(state), () => undefined,
            message => logs.push(message), { platform: "darwin", spawn: () => {
                const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kills: 0,
                    kill() { this.kills++; } }); children.push(child); return child as unknown as MonitorProcess;
            } });
        monitor.focus(true); children[0].emit("exit", 1);
        monitor.focus(true); assert.strictEqual(children.length, 2);
        children[0].stdout.emit("data", "state 1 1 0 0\n"); children[0].emit("error", new Error("late"));
        children[1].stdout.emit("data", "state 0 0 0 0\nstate 1 0 0 0\n");
        assert.deepStrictEqual(states, [keys(), keys(true)]);
        assert.strictEqual(logs.filter(line => line.includes("first sample")).length, 1);
        assert.strictEqual(children[1].kills, 0);
        monitor.dispose();
    });
});
