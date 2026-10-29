import { spawn } from "child_process";
import { ReviewKeyState } from "./keyboardReviewGesture";
import { MonitorProcess } from "./macKeyReleaseMonitor";

// VS Code has no modifier-only key-up API. Use the established CoreGraphics read-only key-state query
// (macKeyReleaseMonitor.ts), confined to the focused Code window. No event tap, input injection, permission
// prompt, shell, global key logger, per-ratchet child or extension-host timer. Only four modifier positions
// are sampled at rest; the four existing navigation positions are read during a modifier gesture. A native
// 10 ms sample observes releases without delaying a single command. Blur/dispose kills this owned child.
export const REVIEW_KEY_MONITOR_SCRIPT = `
ObjC.import('Foundation'); ObjC.import('CoreGraphics');
ObjC.bindFunction('CGEventSourceKeyState', ['bool', ['int', 'unsigned short']]);
ObjC.bindFunction('CGEventSourceCounterForEventType', ['unsigned int', ['int', 'unsigned int']]);
ObjC.bindFunction('getppid', ['int', []]);
function run(argv) {
    var parent = Number(argv[0]);
    var out = $.NSFileHandle.fileHandleWithStandardOutput;
    var down = function(k) { return !!$.CGEventSourceKeyState(0, k); };
    var last = ''; var used = false; var priorShift = false; var priorNav = false; var ticks = 0; var keydowns = 0;
    while (true) {
        if (++ticks % 100 === 0 && Number($.getppid()) !== parent) { return; }
        var option = down(58) || down(61); var shift = down(56) || down(60);
        var nav = (option || shift || priorShift || priorNav) && (down(6) || down(7) || down(43) || down(47));
        var count = Number($.CGEventSourceCounterForEventType(0, 10));
        if (shift && !priorShift) { used = false; keydowns = count; }
        // Any other key makes this a shortcut/selection chord, not a bare Shift tap. Read only a counter,
        // never the key's identity/content. This also protects Option+Shift+arrow word selection.
        if ((shift || priorShift) && count !== keydowns) { used = true; }
        if (shift && nav) { used = true; }
        var line = 'state ' + Number(option) + ' ' + Number(shift) + ' ' + Number(nav) + ' ' + Number(used);
        if (line !== last) {
            out.writeData($.NSString.alloc.initWithUTF8String(line + '\\n').dataUsingEncoding(4)); last = line;
        }
        if (!shift) { used = false; }
        priorShift = shift; priorNav = nav; delay(0.01);
    }
}
`;

export const parseReviewKeyState = (line: string): ReviewKeyState | undefined => {
    const match = /^state ([01]) ([01]) ([01]) ([01])$/.exec(line);
    return match ? { option: match[1] === "1", shift: match[2] === "1", navigation: match[3] === "1", usedShift: match[4] === "1" } : undefined;
};

export class MacReviewKeyMonitor {
    private child: MonitorProcess | undefined;
    private disposed = false;
    constructor(private readonly sample: (state: ReviewKeyState) => void,
        private readonly reset: () => void, private readonly log: (message: string) => void,
        private readonly options: { platform?: string; spawn?: (script: string) => MonitorProcess } = {}) {}

    focus(focused: boolean): void {
        this.stop();
        if (!focused || this.disposed || (this.options.platform ?? process.platform) !== "darwin") { return; }
        let buffer = "";
        let child: MonitorProcess;
        try {
            child = this.options.spawn ? this.options.spawn(REVIEW_KEY_MONITOR_SCRIPT)
                : spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", REVIEW_KEY_MONITOR_SCRIPT, String(process.pid)],
                    { stdio: ["pipe", "pipe", "ignore"] }) as unknown as MonitorProcess;
        } catch { this.log("Keyboard modifier monitor could not start."); return; }
        this.child = child;
        child.stdout?.on("data", (chunk: Buffer | string) => {
            if (this.child !== child) { return; }
            buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            if (buffer.length > 4096) { this.stop(); this.log("Keyboard modifier monitor rejected oversized output."); return; }
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                const state = parseReviewKeyState(line);
                if (!state) { this.stop(); this.log("Keyboard modifier monitor rejected invalid output."); return; }
                this.sample(state);
            }
        });
        const failed = () => {
            if (this.child !== child) { return; }
            this.stop(); this.log("Keyboard modifier monitor stopped; pending keyboard review cancelled.");
        };
        child.on("error", failed); child.on("exit", failed);
    }

    dispose(): void { this.disposed = true; this.stop(); }
    private stop(): void {
        const child = this.child; this.child = undefined;
        child?.kill(); this.reset();
    }
}
