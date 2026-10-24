// Ethan's held "scroll ratchet" review should stop draining backlog when he stops.
// This is a start gate, not a debounce: live steps stay ordered and an already
// running step finishes atomically with its editor/selection update.
export const HELD_WHEEL_IDLE_MS = 300;

export class HeldWheelBurst {
    private readonly owners = new WeakMap<object, { generation: number; lastInput: number }>();

    constructor(private readonly now: () => number = () => performance.now()) {}

    admit(owner: object): () => boolean {
        const now = this.now();
        let state = this.owners.get(owner);
        if (!state) {
            state = { generation: 0, lastInput: now };
            this.owners.set(owner, state);
        } else if (now - state.lastInput > HELD_WHEEL_IDLE_MS) {
            state.generation++;
        }
        state.lastInput = now;
        const generation = state.generation;
        const burst = state;
        return () => generation === burst.generation && this.now() - burst.lastInput <= HELD_WHEEL_IDLE_MS;
    }
}
