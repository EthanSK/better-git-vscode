import * as assert from "assert";
import { HeldWheelBurst, HELD_WHEEL_IDLE_MS } from "../../heldWheelBurst";

suite("Held wheel idle cutoff", () => {
    test("live ratchets start immediately, stay ordered and expire only after idle", () => {
        let now = 0;
        const bursts = new HeldWheelBurst(() => now);
        const hold = {};
        const first = bursts.admit(hold);
        assert.strictEqual(first(), true, "there is no input debounce");
        now = HELD_WHEEL_IDLE_MS - 1;
        const second = bursts.admit(hold);
        now += HELD_WHEEL_IDLE_MS;
        assert.strictEqual(first(), true, "continued input keeps the burst alive");
        assert.strictEqual(second(), true);
        now++;
        assert.strictEqual(first(), false);
        assert.strictEqual(second(), false);
    });
    test("a fresh burst cannot revive old queued ratchets", () => {
        let now = 0;
        const bursts = new HeldWheelBurst(() => now);
        const hold = {};
        const old = bursts.admit(hold);
        now = HELD_WHEEL_IDLE_MS + 1;
        const fresh = bursts.admit(hold);
        assert.strictEqual(old(), false);
        assert.strictEqual(fresh(), true);
    });
    test("another source or a new hold cannot keep an old gesture alive", () => {
        let now = 0;
        const bursts = new HeldWheelBurst(() => now);
        const old = bursts.admit({});
        now = HELD_WHEEL_IDLE_MS + 1;
        const other = bursts.admit({});
        assert.strictEqual(old(), false);
        assert.strictEqual(other(), true);
    });
});
