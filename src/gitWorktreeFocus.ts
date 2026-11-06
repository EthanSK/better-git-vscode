// Native app handoff for explicit Worktree links. Normal return activates the origin after SCM work;
// the separate Keep Editor Front opt-in preserves origin -> exact Code app-switching order before loading.
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
        if (Number(current.processIdentifier) === Number(target.processIdentifier)) {
            if (!editor.activateWithOptions(2)) { return; }
            // Code activation is asynchronous too. Returning at the request used to start SCM while the
            // OS still considered Codex frontmost, needlessly sending the collapse to its expiring retry.
            // Wait only for acknowledgement; a deliberate switch to another app always wins.
            for (let editorAttempt = 0; editorAttempt < 50; editorAttempt++) {
                const editorFront = $.NSWorkspace.sharedWorkspace.frontmostApplication;
                if (!editorFront) { return; }
                if (Number(editorFront.processIdentifier) === Number(editor.processIdentifier)) { return 'editor-active'; }
                if (Number(editorFront.processIdentifier) !== Number(target.processIdentifier)) { return; }
                $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
            }
            return;
        }
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
): Promise<"editor-active" | undefined> {
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
    // Keep Editor Front receives an acknowledgement only for its exact editor. Normal one-way return
    // has no editor acknowledgement; its caller guards the expected front process before activation.
    return result?.stdout?.toString().trim() === "editor-active" ? "editor-active" : undefined;
}
