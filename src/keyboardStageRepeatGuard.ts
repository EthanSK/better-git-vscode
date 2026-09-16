// Held-key auto-repeat guard for the contributed Stage-and-Next / Stage-and-Previous keyboard shortcuts.
//
// VS Code re-dispatches a keybinding for every OS auto-repeat keydown and registerCommand has no key-up
// signal, so holding Shift+Option+X (or Z, < , >) used to stage one file per repeat. The contract here is:
// exactly one stage-and-advance action per continuous physical key hold, and a release followed by a fresh
// press works immediately. Only invocations tagged by the manifest keybindings
// (`{ source: "keyboard", physicalKey }`) are guarded; the F18/F19 mouse user bindings, the command palette,
// the status-bar and editor-title buttons pass no such tag and are never throttled, even while a keyboard
// hold is active.
//
// The exact hold boundary comes from a physical key-release monitor (macKeyReleaseMonitor.ts). When that
// monitor cannot answer (unsupported platform, spawn failure or timeout), the hold degrades to a bounded quiet
// period: it ends once no
// tagged invocation has arrived for FALLBACK_QUIET_MS. A held key keeps repeating inside that window, so a
// failed monitor still cannot stage many files; the cost is only a short lockout after the last repeat.

export type PhysicalStageKey = "x" | "z" | "comma" | "period";

// macOS virtual key codes (kVK_ANSI_*). These are physical positions, so QWERTY and Dvorak share them: the
// Dvorak `q` binding is the same physical X key as the QWERTY `x` binding.
export const PHYSICAL_STAGE_KEY_CODES: Readonly<Record<PhysicalStageKey, number>> = Object.freeze({
    z: 6,
    x: 7,
    comma: 43,
    period: 47,
});

export interface KeyboardStageArgs {
    source: "keyboard";
    physicalKey: PhysicalStageKey;
}

// Only the exact manifest shape is a keyboard tag. Mouse sources ("corsair"/"razer" strings or
// `{ source, direction }` objects), undefined palette/button invocations and unknown keys all return undefined
// and therefore bypass the guard entirely.
export const parseKeyboardStageArgs = (args: unknown): PhysicalStageKey | undefined => {
    if (!args || typeof args !== "object") { return undefined; }
    const candidate = args as { source?: unknown; physicalKey?: unknown };
    if (candidate.source !== "keyboard") { return undefined; }
    const key = candidate.physicalKey;
    return key === "x" || key === "z" || key === "comma" || key === "period" ? key : undefined;
};

export type KeyReleaseOutcome = "released" | "failed";

export interface KeyReleaseMonitor {
    // Resolves "released" once the physical key with this virtual key code is up. Any other resolution,
    // rejection or synchronous throw means the exact boundary is unknown and the guard must fail safely.
    watchRelease(keyCode: number): Promise<KeyReleaseOutcome>;
}

export interface KeyboardStageRepeatGuardOptions {
    monitor: KeyReleaseMonitor;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    fallbackQuietMs?: number;
    log?: (message: string) => void;
}

// Fallback only: a hold without an exact release signal ends once no tagged invocation has arrived for this
// long. Auto-repeat keeps arriving far faster than this while a key is physically down.
export const FALLBACK_QUIET_MS = 500;

export type KeyboardHoldMode = "exact" | "fallback";

interface KeyboardHold {
    id: number;
    key: PhysicalStageKey;
    startedAt: number;
    mode: KeyboardHoldMode;
    timer?: unknown;
}

export class KeyboardStageRepeatGuard {
    private hold: KeyboardHold | undefined;
    private nextHoldId = 1;
    private disposed = false;
    private readonly monitor: KeyReleaseMonitor;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly fallbackQuietMs: number;
    private readonly log: (message: string) => void;

    constructor(options: KeyboardStageRepeatGuardOptions) {
        this.monitor = options.monitor;
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
        this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.fallbackQuietMs = options.fallbackQuietMs ?? FALLBACK_QUIET_MS;
        this.log = options.log ?? (() => undefined);
    }

    // The hold currently owning the shortcut, for diagnostics and tests.
    activeHold(): { key: PhysicalStageKey; mode: KeyboardHoldMode } | undefined {
        return this.hold ? { key: this.hold.key, mode: this.hold.mode } : undefined;
    }

    // Returns true when this tagged invocation is the first press of a hold and must run; false when it is an
    // auto-repeat (or any other tagged key) arriving while the hold is still physically down. Any tagged key
    // refreshes the hold's idle/quiet window: macOS moves auto-repeat to the newest key, so an opposite
    // direction pressed mid-hold must not be mistaken for a fresh press.
    admit(key: PhysicalStageKey): boolean {
        if (this.disposed) { return true; }
        const current = this.hold;
        if (current) {
            if (current.mode === "fallback") { this.armFallbackTimer(current); }
            this.log(`Suppressed ${key} repeat during hold #${current.id} (${current.key}, ${current.mode}).`);
            return false;
        }
        const hold: KeyboardHold = { id: this.nextHoldId++, key, startedAt: this.now(), mode: "exact" };
        this.hold = hold;
        this.log(`Hold #${hold.id} started for ${key}.`);
        let watch: Promise<KeyReleaseOutcome>;
        try {
            watch = Promise.resolve(this.monitor.watchRelease(PHYSICAL_STAGE_KEY_CODES[key]));
        } catch (error) {
            watch = Promise.reject(error);
        }
        void watch.then(
            outcome => this.completeWatch(hold.id, outcome),
            error => {
                this.log(`Release monitor threw for hold #${hold.id}: ${String(error)}`);
                this.completeWatch(hold.id, "failed");
            }
        );
        return true;
    }

    dispose(): void {
        this.disposed = true;
        if (this.hold) {
            this.clearTimer(this.hold.timer);
            this.hold = undefined;
        }
    }

    private completeWatch(holdId: number, outcome: KeyReleaseOutcome): void {
        const hold = this.hold;
        if (!hold || hold.id !== holdId) {
            // A monitor answer for a hold that already ended (idle bound, fallback quiet period, dispose) must
            // never end the hold that replaced it.
            this.log(`Ignored stale release monitor answer (${outcome}) for hold #${holdId}.`);
            return;
        }
        if (outcome !== "released") {
            this.enterFallback(hold, "the release monitor failed");
            return;
        }
        const heldFor = this.now() - hold.startedAt;
        this.endHold(hold, `released after ${heldFor} ms`);
    }

    private enterFallback(hold: KeyboardHold, reason: string): void {
        if (hold.mode === "fallback") { return; }
        hold.mode = "fallback";
        this.log(`Hold #${hold.id} (${hold.key}) using ${this.fallbackQuietMs} ms quiet-period fallback: ${reason}.`);
        this.armFallbackTimer(hold);
    }

    private armFallbackTimer(hold: KeyboardHold): void {
        this.clearTimer(hold.timer);
        hold.timer = this.setTimer(() => this.onFallbackTimer(hold.id), this.fallbackQuietMs);
    }

    private onFallbackTimer(holdId: number): void {
        const hold = this.hold;
        if (!hold || hold.id !== holdId) { return; }
        hold.timer = undefined;
        this.endHold(hold, `quiet for ${this.fallbackQuietMs} ms`);
    }

    private endHold(hold: KeyboardHold, reason: string): void {
        this.clearTimer(hold.timer);
        hold.timer = undefined;
        if (this.hold === hold) { this.hold = undefined; }
        this.log(`Hold #${hold.id} (${hold.key}) ended: ${reason}.`);
    }
}
