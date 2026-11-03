// Observe the first action after an Env Worktree link; never activate apps or delay review input.
import { randomUUID } from "crypto";
import * as path from "path";

export const WORKTREE_USAGE_WINDOW_MS = 60_000;
type Outcome = "review-input-first" | "codex-return-first" | "automatic-return-configured" | "unknown";
type ReviewInput = "review-navigation" | "cursor-move" | "document-edit";
export interface WorktreeUsageEvent {
    id: string;
    event: "click" | "observing" | "outcome";
    elapsedMs: number;
    outcome?: Outcome;
    reason?: string;
}

// Ethan's "started reviewing vs return to Codex" means observable input, not merely an opened diff.
// Arm only after the automatic Codex -> Code handoff: that scripted bounce must never count as his return.
// One bounded observation per explicit link uses existing VS Code events, with no polling or file contents.
export class WorktreeUsage {
    private readonly id = randomUUID();
    private readonly startedAt: number;
    private observing = false;
    private finished = false;
    private focusRevision = 0;
    private pendingFocusProbe = false;
    private readonly expiry: ReturnType<typeof setTimeout>;

    constructor(private readonly root: string,
        private readonly emit: (event: WorktreeUsageEvent) => void,
        private readonly frontmostApp: () => Promise<string | undefined>,
        private readonly focused: () => boolean,
        private readonly now: () => number = () => performance.now()) {
        this.startedAt = now();
        this.write("click");
        // This is an observation cutoff, not a pause before opening/reviewing the worktree.
        this.expiry = setTimeout(() => this.finish("observation-ended"), WORKTREE_USAGE_WINDOW_MS);
        this.expiry.unref();
    }

    arm(): void {
        if (this.finished || this.observing) { return; }
        this.observing = true;
        this.write("observing");
        // A failed/late editor activation and a very fast user return look identical here. Require
        // observed editor focus after the handoff rather than attributing its Codex bounce to the user.
        if (!this.focused()) { this.complete("unknown", "handoff-ended-unfocused"); }
    }

    reviewInput(input: ReviewInput, file: string | undefined): void {
        if (!this.observing || this.finished || !this.focused() || !file) { return; }
        const relative = path.relative(this.root, file);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { return; }
        // A fast switch back before the native sample finishes is ambiguous; do not reverse event order.
        this.complete(this.pendingFocusProbe ? "unknown" : "review-input-first",
            this.pendingFocusProbe ? "focus-sample-raced-review" : input);
    }

    focusChanged(focused: boolean): void {
        if (!this.observing || this.finished) { return; }
        const revision = ++this.focusRevision;
        if (focused) { return; }
        this.pendingFocusProbe = true;
        void this.frontmostApp().then(bundle => {
            if (this.finished || revision !== this.focusRevision || this.focused()) { return; }
            this.complete(bundle === "com.openai.codex" ? "codex-return-first" : "unknown",
                bundle === "com.openai.codex" ? "codex-frontmost" : bundle ? "other-app-frontmost" : "app-unavailable");
        }, () => {
            if (!this.finished && revision === this.focusRevision && !this.focused()) {
                this.complete("unknown", "app-probe-failed");
            }
        });
    }

    finish(reason: string): void { this.complete("unknown", reason); }
    automaticReturnConfigured(): void { this.complete("automatic-return-configured", "configured-origin-return"); }
    dispose(): void { this.finish("extension-disposed"); }

    private complete(outcome: Outcome, reason: string): void {
        if (this.finished) { return; }
        this.finished = true;
        clearTimeout(this.expiry);
        this.write("outcome", outcome, reason);
    }

    private write(event: WorktreeUsageEvent["event"], outcome?: Outcome, reason?: string): void {
        try {
            this.emit({ id: this.id, event, elapsedMs: Math.round(this.now() - this.startedAt),
                ...(outcome ? { outcome, reason } : {}) });
        } catch { /* Diagnostics must never break opening, navigation or staging. */ }
    }
}
