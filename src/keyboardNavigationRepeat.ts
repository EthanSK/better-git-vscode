// Pace a continuous keyboard Next/Previous hold, never separate presses or mouse/wand steps.
// The existing modifier sampler supplies releases; navigation calls this before joining its work queue.
import { PhysicalStageKey } from "./keyboardStageRepeatGuard";

// Ethan chose a 100 ms glance gap (2026-11-02), measured after completion, not before the first step.
export const KEYBOARD_NAVIGATION_REPEAT_MS = 100;
export const NAVIGATION_KEY_BITS: Readonly<Record<PhysicalStageKey, number>> = Object.freeze({
    z: 1, x: 2, comma: 4, period: 8,
});
interface Hold { id: number; completedAt: number; busy: boolean; }
export interface NavigationRepeatPermit { readonly key: PhysicalStageKey; readonly holdId?: number; }

export class KeyboardNavigationRepeat {
    private readonly holds = new Map<PhysicalStageKey, Hold>();
    private known = false;
    private nextId = 0;

    constructor(private readonly now: () => number = () => performance.now()) {}

    sample(mask: number): void {
        this.known = true;
        for (const key of this.holds.keys()) {
            if (!(mask & NAVIGATION_KEY_BITS[key])) { this.holds.delete(key); }
        }
    }

    reset(): void { this.known = false; this.holds.clear(); }

    admit(key: PhysicalStageKey): NavigationRepeatPermit | undefined {
        // Without a verified physical release stream, preserve intentional presses instead of guessing
        // that closely-spaced presses are auto-repeat. No quiet-period debounce is introduced.
        if (!this.known) { return { key }; }
        const now = this.now();
        let hold = this.holds.get(key);
        if (hold) {
            // Ethan wants time to glance at each change and no held-repeat processing backlog. Suppress
            // redundant OS repeats before navigation queues them; a new physical press always gets in.
            if (hold.busy || now - hold.completedAt < KEYBOARD_NAVIGATION_REPEAT_MS) { return undefined; }
            hold.busy = true;
        } else {
            hold = { id: ++this.nextId, completedAt: now, busy: true };
            this.holds.set(key, hold);
        }
        return { key, holdId: hold.id };
    }

    complete(permit: NavigationRepeatPermit): void {
        const hold = this.holds.get(permit.key);
        if (hold && hold.id === permit.holdId) {
            // The glance interval starts when the change has opened, not before slow Git/rendering work.
            hold.completedAt = this.now(); hold.busy = false;
        }
    }
}
