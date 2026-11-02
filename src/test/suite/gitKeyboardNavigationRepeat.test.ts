// Non-GUI contracts for paced held navigation, exact fresh presses and no held-repeat backlog.
import * as assert from "assert";
import { KeyboardNavigationRepeat, KEYBOARD_NAVIGATION_REPEAT_MS, NAVIGATION_KEY_BITS } from "../../keyboardNavigationRepeat";

suite("Held keyboard navigation repeats", () => {
    test("first press is immediate, then completed repeats are spaced by 100 ms", () => {
        assert.strictEqual(KEYBOARD_NAVIGATION_REPEAT_MS, 100, "preserve Ethan's chosen glance interval");
        let now = 0; const repeat = new KeyboardNavigationRepeat(() => now);
        repeat.sample(NAVIGATION_KEY_BITS.x);
        const first = repeat.admit("x"); assert.ok(first); repeat.complete(first);
        now = KEYBOARD_NAVIGATION_REPEAT_MS - 1; assert.strictEqual(repeat.admit("x"), undefined);
        now++; assert.ok(repeat.admit("x"));
    });
    test("a slow operation never accumulates additional auto-repeats", () => {
        let now = 0; const repeat = new KeyboardNavigationRepeat(() => now); repeat.sample(2);
        const first = repeat.admit("x"); assert.ok(first);
        for (now = 100; now <= 6000; now += 100) { assert.strictEqual(repeat.admit("x"), undefined); }
        repeat.complete(first); assert.strictEqual(repeat.admit("x"), undefined);
        now += KEYBOARD_NAVIGATION_REPEAT_MS; assert.ok(repeat.admit("x"));
    });
    test("release and re-press immediately admit a fresh operation while an older one is still running", () => {
        const repeat = new KeyboardNavigationRepeat(() => 0); repeat.sample(2);
        const first = repeat.admit("x"); assert.ok(first); repeat.sample(0); repeat.sample(2);
        const second = repeat.admit("x"); assert.ok(second); assert.notStrictEqual(second.holdId, first.holdId);
        repeat.complete(first); assert.strictEqual(repeat.admit("x"), undefined);
        repeat.complete(second);
    });
    test("opposite and alternate physical keys own separate holds", () => {
        const repeat = new KeyboardNavigationRepeat(() => 0); repeat.sample(15);
        for (const key of ["x", "z", "period", "comma"] as const) { assert.ok(repeat.admit(key)); }
        repeat.sample(2); assert.ok(repeat.admit("z")); assert.strictEqual(repeat.admit("x"), undefined);
    });
    test("unknown or stopped native monitoring never guesses that a fresh command is a repeat", () => {
        const repeat = new KeyboardNavigationRepeat(() => 0);
        assert.ok(repeat.admit("x")); assert.ok(repeat.admit("x"));
        repeat.sample(2); assert.ok(repeat.admit("x")); assert.strictEqual(repeat.admit("x"), undefined);
        repeat.reset(); assert.ok(repeat.admit("x")); assert.ok(repeat.admit("x"));
    });
});
