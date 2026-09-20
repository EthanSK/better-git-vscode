import { execFile } from "child_process";
import { promisify } from "util";
import { normalizeReturnApp } from "./gitWorktreeLink";

const runFile = promisify(execFile);

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
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const allowed = ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.google.Chrome',
    'com.apple.Safari', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'com.brave.Browser',
    'com.openai.codex', destination];
const targets = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(destination);
if (front && allowed.includes(ObjC.unwrap(front.bundleIdentifier)) && Number(targets.count) === 1) {
    const target = targets.objectAtIndex(0);
    let editor;
    if (['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'].includes(editorId) && destination !== editorId) {
        // Preserve the exact editor process when multiple installations are running.
        if (ObjC.unwrap(front.bundleIdentifier) === editorId) {
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
            editor.activateWithOptions(2);
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
    editorBundleId?: string
): Promise<void> {
    const bundleId = normalizeReturnApp(destination);
    if (platform !== "darwin" || !bundleId) { return; }
    // Best effort: a focus failure must not undo or misreport a successful reveal.
    const args = ["-l", "JavaScript", "-e", RETURN_TO_APP_SCRIPT, bundleId];
    if (editorBundleId === "com.microsoft.VSCode" || editorBundleId === "com.microsoft.VSCodeInsiders") {
        args.push(editorBundleId);
    }
    await run("/usr/bin/osascript", args, { timeout: 5000 });
}
