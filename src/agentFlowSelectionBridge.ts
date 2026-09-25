import * as vscode from "vscode";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { randomUUID } from "crypto";
import { agentFlowSelectionIsFresh, parseAgentFlowSelectionRequest } from "./agentFlowSelectionProtocol";

/**
 * Monaco deliberately hides its text from macOS AX when screen-reader mode is off.
 * AgentFlow therefore pulls one fresh, user-made editor selection through VS Code's
 * public API. Never enable accessibility mode, copy, execute an editor command, poll,
 * cache selected text, or change focus. Ordinary Git/navigation latency is untouched.
 *
 * A private per-user Unix socket has no TCP/network endpoint. Only a request tied to
 * the current mouse gesture and focused VS Code PID can read text. Other windows,
 * programmatic hunk selections, old highlights, terminals and webviews return null.
 * See https://code.visualstudio.com/api/references/vscode-api#TextEditorSelectionChangeEvent
 */
export function registerAgentFlowSelectionBridge(context: vscode.ExtensionContext): void {
    if (process.platform !== "darwin" || !process.getuid || vscode.env.remoteName) { return; }
    const mainPID = Number(process.env.VSCODE_PID);
    if (!Number.isSafeInteger(mainPID) || mainPID <= 0) { return; }
    const directory = `/tmp/agentflow-selection-${process.getuid()}`;
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") { return; }
    }
    try {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
            directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0) { return; }
    } catch { return; }

    let latest: { editor: vscode.TextEditor; selection: vscode.Selection; version: number; changedAt: number } | undefined;
    let disposed = false;
    const socketPath = path.join(directory, `vscode-${mainPID}-${process.pid}-${randomUUID()}.sock`);
    const clients = new Set<net.Socket>();
    const clear = () => { latest = undefined; };
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            clear();
            // API/command-driven hunk movement is not a highlight gesture. Keep only
            // selection coordinates; read the bounded text lazily after a valid pull.
            if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse && vscode.window.state.focused &&
                event.textEditor === vscode.window.activeTextEditor && event.selections.length === 1 &&
                !event.selections[0].isEmpty) {
                latest = { editor: event.textEditor, selection: event.selections[0],
                    version: event.textEditor.document.version, changedAt: Date.now() };
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(clear),
        vscode.window.onDidChangeWindowState(state => { if (!state.focused) { clear(); } }),
        vscode.workspace.onDidChangeTextDocument(event => { if (latest?.editor.document === event.document) { clear(); } })
    );

    const server = net.createServer(socket => {
        if (disposed || clients.size >= 8) { socket.destroy(); return; }
        clients.add(socket);
        socket.setTimeout(500, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("close", () => clients.delete(socket));
        let input = Buffer.alloc(0);
        let handled = false;
        socket.on("data", chunk => {
            if (handled) { return; }
            input = Buffer.concat([input, chunk]);
            if (input.length > 1024) { socket.destroy(); return; }
            if (!input.includes(10)) { return; }
            handled = true;
            let result: object | null = null;
            try {
                const request = parseAgentFlowSelectionRequest(JSON.parse(input.toString("utf8").trim()));
                const current = latest;
                if (request && request.sourcePID === mainPID && current && vscode.window.state.focused &&
                    current.editor === vscode.window.activeTextEditor &&
                    vscode.window.visibleTextEditors.includes(current.editor) &&
                    current.editor.document.version === current.version &&
                    current.editor.selection.isEqual(current.selection) &&
                    agentFlowSelectionIsFresh(request, current.changedAt)) {
                    const document = current.editor.document;
                    const start = document.offsetAt(current.selection.start);
                    const end = Math.min(document.offsetAt(current.selection.end), start + 8192);
                    // Do not split a UTF-16 surrogate pair at the transport bound.
                    const text = document.getText(new vscode.Range(current.selection.start, document.positionAt(end)))
                        .replace(/[\uD800-\uDBFF]$/, "");
                    result = { version: 1, nonce: request.nonce, sourcePID: mainPID,
                        changedAt: current.changedAt, text };
                }
            } catch { /* Malformed/disappearing editor: no content and no log. */ }
            socket.end(JSON.stringify(result) + "\n");
        });
    });
    server.on("error", () => { /* Optional bridge failure must never break Better Git activation. */ });
    server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { server.close(); }
        if (disposed) { server.close(); }
    });
    server.unref();
    context.subscriptions.push(new vscode.Disposable(() => {
        disposed = true;
        clear();
        for (const socket of clients) { socket.destroy(); }
        server.close(); // Node removes its own Unix socket; never delete another host's endpoint.
    }));
}
