import { execFile } from "child_process";
import { promisify } from "util";

const runFile = promisify(execFile);

// AppKit activation needs no Accessibility/Automation grant. Only activate an
// already-running Codex; never launch it or accept an application from the URL.
// Check focus at completion so a switch to another app wins over this handoff.
export const RETURN_TO_CODEX_SCRIPT = `
ObjC.import('AppKit');
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const allowed = ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.google.Chrome', 'com.openai.codex'];
const targets = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.openai.codex');
if (front && allowed.includes(ObjC.unwrap(front.bundleIdentifier)) && Number(targets.count) === 1) {
    targets.objectAtIndex(0).activateWithOptions(2);
}
`;

export async function returnToCodex(
    platform: NodeJS.Platform = process.platform,
    run: typeof runFile = runFile
): Promise<void> {
    if (platform !== "darwin") { return; }
    // Best effort: a focus failure must not undo or misreport a successful reveal.
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", RETURN_TO_CODEX_SCRIPT], { timeout: 5000 });
}
