import { execFile } from "child_process";
import { promisify } from "util";
import { normalizeReturnApp } from "./gitWorktreeLink";

const runFile = promisify(execFile);

// AppKit activation needs no Accessibility/Automation grant. Only activate an
// already-running app; never launch it or interpret URL metadata as code.
// Check focus at completion so a switch to another app wins over this handoff.
export const RETURN_TO_APP_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
const destination = argv[0];
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const allowed = ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.google.Chrome',
    'com.apple.Safari', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'com.brave.Browser',
    'com.openai.codex', destination];
const targets = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(destination);
if (front && allowed.includes(ObjC.unwrap(front.bundleIdentifier)) && Number(targets.count) === 1) {
    targets.objectAtIndex(0).activateWithOptions(2);
}
}
`;

export async function returnToApp(
    destination: string,
    platform: NodeJS.Platform = process.platform,
    run: typeof runFile = runFile
): Promise<void> {
    const bundleId = normalizeReturnApp(destination);
    if (platform !== "darwin" || !bundleId) { return; }
    // Best effort: a focus failure must not undo or misreport a successful reveal.
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", RETURN_TO_APP_SCRIPT, bundleId], { timeout: 5000 });
}
