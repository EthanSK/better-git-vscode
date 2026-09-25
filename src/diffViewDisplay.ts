import { execFile } from "child_process";
import * as vscode from "vscode";
import { MacDisplay, matchDisplay, parseDisplayTarget } from "./gitDiffViewDisplayMatch";

// A fresh, short-lived probe sees hot-plug changes even when the extension host stays open.
// It never reads window titles, screen content, or the frontmost application.
const displayProbe = `ObjC.import("AppKit"); ObjC.import("CoreGraphics");
const screens=$.NSScreen.screens; const out=[];
for(let i=0;i<screens.count;i++){
  const s=screens.objectAtIndex(i);
  const id=ObjC.deepUnwrap(s.deviceDescription).NSScreenNumber;
  const ref=$.CGDisplayCreateUUIDFromDisplayID(id);
  const uuid=ref ? ObjC.unwrap(ObjC.castRefToObject($.CFUUIDCreateString(null,ref))) : "";
  const f=s.frame;
  out.push({uuid,width:f.size.width,height:f.size.height,builtIn:$.CGDisplayIsBuiltin(id)!==0});
}
JSON.stringify(out);`;

export function probeDisplays(): Promise<MacDisplay[]> {
    return new Promise((resolve, reject) => {
        execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", displayProbe],
            { timeout: 1500, maxBuffer: 16 * 1024 }, (error, stdout) => {
                if (error) { reject(error); return; }
                try {
                    const result: unknown = JSON.parse(stdout);
                    if (!Array.isArray(result) || !result.every((display) =>
                        display && typeof display.uuid === "string" && typeof display.builtIn === "boolean"
                        && Number.isFinite(display.width) && Number.isFinite(display.height))) {
                        throw new Error("Unexpected display probe result");
                    }
                    resolve(result as MacDisplay[]);
                } catch (parseError) { reject(parseError); }
            });
    });
}

export function registerDiffViewDisplay(context: vscode.ExtensionContext, log: (message: string) => void): void {
    if (process.platform !== "darwin") { return; }
    let disposed = false;
    let running = false;
    let pending = false;

    const refresh = async (): Promise<void> => {
        if (disposed) { return; }
        if (running) { pending = true; return; }
        running = true;
        try {
            do {
                pending = false;
                const target = parseDisplayTarget(vscode.workspace.getConfiguration("better-git-vscode")
                    .get<unknown>("inlineDiffOnDisplay"));
                if (!target) { continue; }
                try {
                    const connected = matchDisplay(target, await probeDisplays());
                    if (disposed || connected === undefined) { continue; }
                    const currentTarget = parseDisplayTarget(vscode.workspace.getConfiguration("better-git-vscode")
                        .get<unknown>("inlineDiffOnDisplay"));
                    if (!currentTarget || currentTarget.uuid !== target.uuid
                        || currentTarget.width !== target.width || currentTarget.height !== target.height) { continue; }
                    // VS Code's diff-view commands require an active diff. Settings also work at startup,
                    // before any editor is open. Automatic is side-by-side with inline on narrow editors.
                    const diff = vscode.workspace.getConfiguration("diffEditor");
                    const desiredSideBySide = !connected;
                    const narrow = diff.inspect<boolean>("useInlineViewWhenSpaceIsLimited");
                    if ((narrow?.globalValue ?? narrow?.defaultValue) !== true) {
                        await diff.update("useInlineViewWhenSpaceIsLimited", true, vscode.ConfigurationTarget.Global);
                    }
                    if (disposed) { continue; }
                    const sideBySide = diff.inspect<boolean>("renderSideBySide");
                    if ((sideBySide?.globalValue ?? sideBySide?.defaultValue) !== desiredSideBySide) {
                        await diff.update("renderSideBySide", desiredSideBySide, vscode.ConfigurationTarget.Global);
                        log(`Display ${connected ? "connected" : "disconnected"}; diff view set to ${connected ? "Inline" : "Automatic"}.`);
                    }
                } catch (error) { log(`Display check failed: ${String(error)}`); }
            } while (pending && !disposed);
        } finally { running = false; }
    };

    const interval = setInterval(() => { void refresh(); }, 5000);
    context.subscriptions.push(
        { dispose: () => { disposed = true; clearInterval(interval); } },
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("better-git-vscode.inlineDiffOnDisplay")) { void refresh(); }
        }),
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) { void refresh(); }
        }),
    );
    void refresh();
}
