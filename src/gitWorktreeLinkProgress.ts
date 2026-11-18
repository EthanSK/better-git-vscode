// Optional feedback for one explicit link. Update the clock only while visible and in flight.
// A superseded link can finish asynchronously but must never overwrite the newer link's status.
import * as vscode from "vscode";
import { performance } from "perf_hooks";
import { WorktreePresentationEndReason } from "./gitWorktreePresentation";

export function worktreeStopMessage(reason?: WorktreePresentationEndReason): string {
    switch (reason) {
        case "expired": return "Timed out waiting for the VS Code window";
        case "cursor-move": return "Stopped after the cursor moved";
        case "document-edit": return "Stopped after the file was edited";
        case "review-navigation": return "Stopped after review navigation";
        case "newer-link": return "Replaced by a newer link";
        case "not-owned": return "Stopped after the active file changed";
        default: return "Stopped";
    }
}

export class WorktreeLinkProgress {
    private readonly started = performance.now();
    private readonly item?: vscode.StatusBarItem;
    private timer?: NodeJS.Timeout;
    private hideTimer?: NodeJS.Timeout;
    private ended = false;
    private phase = "Waiting to open";

    constructor(private readonly target: string, visible: boolean, private readonly log: (message: string) => void) {
        if (visible) {
            this.item = vscode.window.createStatusBarItem("worktreeLink", vscode.StatusBarAlignment.Left, 10000);
            this.item.name = "Better Git Worktree link";
            this.render();
            this.item.show();
            this.timer = setInterval(() => this.render(), 1000);
        }
    }

    private render(): void {
        if (this.item) {
            const seconds = Math.floor((performance.now() - this.started) / 1000);
            this.item.text = `${this.ended ? "$(git-branch)" : "$(sync~spin)"} ${this.target} · ${this.phase} · ${seconds}s`;
        }
    }

    update(phase: string): void {
        if (this.ended || this.phase === phase) { return; }
        this.phase = phase;
        this.log(`${phase} (${Math.round(performance.now() - this.started)}ms)`);
        this.render();
    }

    finish(message: string): void {
        if (this.ended) { return; }
        this.update(message);
        this.ended = true;
        clearInterval(this.timer);
        this.render();
        if (this.item) { this.hideTimer = setTimeout(() => this.dispose(), 8000); }
    }

    dispose(): void {
        this.ended = true;
        clearInterval(this.timer);
        clearTimeout(this.hideTimer);
        this.item?.dispose();
    }
}
