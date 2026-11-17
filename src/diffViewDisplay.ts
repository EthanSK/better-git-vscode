import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { MacDisplay, matchDisplay, parseDisplayTarget } from "./gitDiffViewDisplayMatch";
import { parseDisplayZoomLevels } from "./displayZoomLevels";
import { DiffViewDisplaySession } from "./diffViewDisplaySession";

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

const layoutKeys = ["useInlineViewWhenSpaceIsLimited", "renderSideBySide"] as const;
type LayoutKey = typeof layoutKeys[number];

function readLayoutSetting(key: LayoutKey) {
    return vscode.workspace.getConfiguration("diffEditor").inspect<boolean>(key);
}

export function registerDiffViewDisplay(context: vscode.ExtensionContext, log: (message: string) => void): void {
    // Ethan re-enabled his monitor-based Inline/Automatic behavior after trying Automatic-only. It remains
    // opt-in via a configured display target; do not make his monitor or zoom choices defaults for others.
    if (process.platform !== "darwin") { return; }
    // Desktop VS Code can present its local profile storage as vscode-userdata. Use the
    // filesystem path as the stage history does, including in isolated Extension Hosts.
    const session = new DiffViewDisplaySession(path.join(context.globalStorageUri.fsPath, "display-layout"));
    let disposed = false;
    let running = false;
    let pending = false;
    let lastZoomState: string | undefined;
    let isLayoutWriter = false;
    let manualRevision = 0;
    let manualChoice: Promise<void> | undefined;
    let layoutObservation: Record<LayoutKey, boolean | undefined> = {
        useInlineViewWhenSpaceIsLimited: undefined, renderSideBySide: undefined,
    };
    const expectedWrites = new Map<LayoutKey, boolean>();
    const report = (error: unknown): void => log(`Display check failed: ${String(error)}`);

    const observeLayout = (): void => {
        let externalChange = false;
        for (const key of layoutKeys) {
            const value = readLayoutSetting(key)?.globalValue;
            if (layoutObservation[key] === value) { continue; }
            layoutObservation[key] = value;
            // Claim only the value we wrote for this particular key. The native Side by Side
            // command changes two settings, and its other write may arrive during ours.
            if (expectedWrites.get(key) !== value || !expectedWrites.has(key)) { externalChange = true; }
            expectedWrites.delete(key);
        }
        if (!externalChange || !parseDisplayTarget(vscode.workspace.getConfiguration("better-git-vscode")
            .get<unknown>("inlineDiffOnDisplay"))) { return; }
        // Ethan's manual Inline or Side by Side choice takes priority for this editor session,
        // including when the display changes. Selecting Side by Side also disables narrow fallback.
        manualRevision++;
        const choice = (manualChoice?.catch(() => undefined) ?? Promise.resolve()).then(() => session.holdManualLayout());
        manualChoice = choice;
        void choice.then(() => {
            if (manualChoice === choice) { manualChoice = undefined; }
        }, report);
    };
    const writeLayoutSetting = async (key: LayoutKey, value: boolean, revision: number): Promise<boolean> => {
        observeLayout();
        if (disposed || manualChoice || revision !== manualRevision) { return false; }
        const setting = readLayoutSetting(key);
        if ((setting?.globalValue ?? setting?.defaultValue) === value) { return false; }
        expectedWrites.set(key, value);
        try {
            await vscode.workspace.getConfiguration("diffEditor").update(key, value, vscode.ConfigurationTarget.Global);
        } catch (error) {
            expectedWrites.delete(key);
            throw error;
        }
        return true;
    };

    const refresh = async (): Promise<void> => {
        if (disposed) { return; }
        if (running) { pending = true; return; }
        running = true;
        try {
            do {
                pending = false;
                const target = parseDisplayTarget(vscode.workspace.getConfiguration("better-git-vscode")
                    .get<unknown>("inlineDiffOnDisplay"));
                if (!target) {
                    lastZoomState = undefined;
                    const wasWriter = isLayoutWriter;
                    isLayoutWriter = false;
                    expectedWrites.clear();
                    // Explicitly opting out and back in starts display control again.
                    if (wasWriter) {
                        await manualChoice?.catch(() => undefined);
                        await session.clearManualLayout().catch(report);
                        manualChoice = undefined;
                    }
                    continue;
                }
                try {
                    // Capture before I/O: a manual choice can arrive and be fully recorded while the display probe runs.
                    const layoutRevision = manualRevision;
                    const layout = await session.join(vscode.window.state.focused).then(() => session.state()).catch(error => {
                        report(error);
                        return { writer: false, manual: false };
                    });
                    if (disposed) { continue; }
                    if (layout.writer && !isLayoutWriter) {
                        for (const key of layoutKeys) { layoutObservation[key] = readLayoutSetting(key)?.globalValue; }
                    }
                    isLayoutWriter = layout.writer;
                    if ((!layout.writer || layout.manual || manualChoice) && !parseDisplayZoomLevels(
                        vscode.workspace.getConfiguration("better-git-vscode").get<unknown>("zoomLevelOnDisplay")
                    )) {
                        lastZoomState = undefined;
                        continue;
                    }
                    const connected = matchDisplay(target, await probeDisplays());
                    if (disposed || connected === undefined) { continue; }
                    const currentTarget = parseDisplayTarget(vscode.workspace.getConfiguration("better-git-vscode")
                        .get<unknown>("inlineDiffOnDisplay"));
                    if (!currentTarget || currentTarget.uuid !== target.uuid
                        || currentTarget.width !== target.width || currentTarget.height !== target.height) {
                        lastZoomState = undefined;
                        continue;
                    }
                    if (isLayoutWriter && !layout.manual && !manualChoice) {
                        // These User settings also apply before an editor opens. VS Code's Automatic
                        // mode uses side by side with an inline fallback for narrow editors.
                        await writeLayoutSetting("useInlineViewWhenSpaceIsLimited", true, layoutRevision);
                        if (await writeLayoutSetting("renderSideBySide", !connected, layoutRevision)) {
                            log(`Display ${connected ? "connected" : "disconnected"}; diff view set to ${connected ? "Inline" : "Automatic"}.`);
                        }
                    }

                    if (disposed) { continue; }
                    const levels = parseDisplayZoomLevels(vscode.workspace.getConfiguration("better-git-vscode")
                        .get<unknown>("zoomLevelOnDisplay"));
                    if (!levels) { lastZoomState = undefined; continue; }
                    const zoomState = `${target.uuid}:${target.width}x${target.height}:${levels.connected}:${levels.disconnected}:${connected}`;
                    // Apply on startup, display transition or preference change. A manual zoom change
                    // during the same display state remains Ethan's until the next transition.
                    if (zoomState !== lastZoomState) {
                        const desiredZoom = connected ? levels.connected : levels.disconnected;
                        const window = vscode.workspace.getConfiguration("window");
                        if (window.get<number>("zoomLevel") !== desiredZoom) {
                            await window.update("zoomLevel", desiredZoom, vscode.ConfigurationTarget.Global);
                            log(`Display ${connected ? "connected" : "disconnected"}; VS Code zoom set to ${desiredZoom}.`);
                        }
                        lastZoomState = zoomState;
                    }
                } catch (error) { report(error); }
            } while (pending && !disposed);
        } finally { running = false; }
    };

    const interval = setInterval(() => { void refresh(); }, 5000);
    context.subscriptions.push(
        { dispose: () => {
            disposed = true;
            clearInterval(interval);
            void session.dispose().catch(report);
        } },
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (isLayoutWriter && layoutKeys.some(key => event.affectsConfiguration(`diffEditor.${key}`))) {
                observeLayout();
            }
            if (event.affectsConfiguration("better-git-vscode.inlineDiffOnDisplay")
                || event.affectsConfiguration("better-git-vscode.zoomLevelOnDisplay")) { void refresh(); }
        }),
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                void session.focus().catch(report).then(refresh);
            }
        }),
    );
    void refresh();
}
