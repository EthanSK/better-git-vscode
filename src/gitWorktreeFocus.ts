// Native app handoff for explicit Worktree links. Normal return activates the origin after SCM work;
// Keep Editor Front acknowledges the origin, then lets the owning VS Code window focus itself.
import { execFile } from "child_process";
import { promisify } from "util";
import { normalizeReturnApp } from "./gitWorktreeLink";

const runFile = promisify(execFile);

// Read only the active app identity on a focus-loss event. No Accessibility, activation or polling.
export async function frontmostAppBundleId(): Promise<string | undefined> {
    if (process.platform !== "darwin") { return undefined; }
    const { stdout } = await runFile("/usr/bin/osascript", ["-l", "JavaScript", "-e",
        "ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace.frontmostApplication; app ? ObjC.unwrap(app.bundleIdentifier) : '';"],
    { timeout: 1500 });
    return stdout.trim() || undefined;
}

// AppKit activation needs no Accessibility/Automation grant. Only activate an
// already-running app; never launch it or interpret URL metadata as code.
// Check focus at completion so a switch to another app wins over this handoff.
// Pump the run loop during acknowledgement: sleeping leaves NSWorkspace's
// cached frontmostApplication stale even after the OS has activated the app.
export const RETURN_TO_APP_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
const destination = argv[0];
const editorId = argv[1];
const editorPid = Number(argv[2]);
const expectedFrontPid = Number(argv[3]);
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
if (Number.isInteger(expectedFrontPid) && expectedFrontPid > 0
    && (!front || Number(front.processIdentifier) !== expectedFrontPid)) { return; }
const allowed = ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.google.Chrome',
    'com.apple.Safari', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'com.brave.Browser',
    'com.openai.codex', destination];
const targets = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(destination);
if (front && allowed.includes(ObjC.unwrap(front.bundleIdentifier)) && Number(targets.count) === 1) {
    const target = targets.objectAtIndex(0);
    let editor;
    if (['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'].includes(editorId) && destination !== editorId) {
        // Preserve the exact editor process when multiple installations are running.
        if (Number.isInteger(editorPid) && editorPid > 0) {
            const candidate = $.NSRunningApplication.runningApplicationWithProcessIdentifier(editorPid);
            if (candidate && Number(candidate.processIdentifier) === editorPid && candidate.bundleIdentifier
                && ObjC.unwrap(candidate.bundleIdentifier) === editorId) {
                editor = candidate;
            }
        } else if (ObjC.unwrap(front.bundleIdentifier) === editorId) {
            editor = front;
        } else {
            const editors = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(editorId);
            if (Number(editors.count) === 1) { editor = editors.objectAtIndex(0); }
        }
        // Do not strand the user in the origin when the requested editor is ambiguous.
        if (!editor) { return; }
    }
    if (!target.activateWithOptions(2) || !editor) { return; }
    // Activation is asynchronous. Wait for acknowledgement, not a fixed delay,
    // so macOS records the origin in its app-switching order before returning.
    for (let attempt = 0; attempt < 50; attempt++) {
        const current = $.NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!current) { return; }
        // AppKit can confirm an app, but it cannot choose between Code windows
        // in the same process. The caller uses VS Code's own Focus Window.
        if (Number(current.processIdentifier) === Number(target.processIdentifier)) { return 'origin-active'; }
        // A deliberate switch to any other process wins, even another browser.
        if (Number(current.processIdentifier) !== Number(front.processIdentifier)) { return; }
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
    }
}
}
`;

export async function returnToApp(
    destination: string,
    platform: NodeJS.Platform = process.platform,
    run: typeof runFile = runFile,
    editorBundleId?: string,
    editorProcessId?: number,
    expectedFrontProcessId?: number
): Promise<"origin-active" | undefined> {
    const bundleId = normalizeReturnApp(destination);
    if (platform !== "darwin" || !bundleId) { return; }
    // Best effort: a focus failure must not undo or misreport a successful reveal.
    const args = ["-l", "JavaScript", "-e", RETURN_TO_APP_SCRIPT, bundleId];
    const editorId = editorBundleId === "com.microsoft.VSCode" || editorBundleId === "com.microsoft.VSCodeInsiders"
        ? editorBundleId : undefined;
    const validPid = (value: number | undefined): value is number => typeof value === "number"
        && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
    if (editorId || validPid(expectedFrontProcessId)) { args.push(editorId ?? ""); }
    if ((editorId !== undefined && validPid(editorProcessId)) || validPid(expectedFrontProcessId)) {
        args.push(editorId && validPid(editorProcessId) ? String(editorProcessId) : "");
    }
    if (validPid(expectedFrontProcessId)) { args.push(String(expectedFrontProcessId)); }
    const result = await run("/usr/bin/osascript", args, { timeout: 5000 });
    // Normal one-way return has no acknowledgement. Keep Editor Front returns
    // once the origin is visible and delegates exact window focus to VS Code.
    return result?.stdout?.toString().trim() === "origin-active" ? "origin-active" : undefined;
}
