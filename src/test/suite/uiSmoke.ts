import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as vscode from "vscode";

// Optional manual/Computer Use acceptance harness. It creates two known changes,
// then verifies Git state after real UI staging and keyboard Undo, without
// invoking the commands under test itself.
export async function run(): Promise<void> {
    if (process.env.BGV_TEST_START_DELAY_MS) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.BGV_TEST_START_DELAY_MS)));
    }
    if (process.env.BGV_PLACE_ON_MACBOOK === "1") {
        const pid = process.env.VSCODE_PID;
        const workspace = vscode.workspace.workspaceFile;
        if (!pid || !/^\d+$/.test(pid) || !workspace) { throw new Error("Missing isolated test window identity"); }
        console.log(execFileSync("swift", [
            path.resolve(__dirname, "../../../scripts/place-vscode-window-on-macbook.swift"), pid,
            path.basename(workspace.fsPath, ".code-workspace"),
        ], { encoding: "utf8", timeout: 20000 }));
    }
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const extension = vscode.extensions.getExtension<any>("EthanSK.better-git-vscode")!;
    const api = await extension.activate();
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!;
    const git = (await gitExtension.activate()).getAPI(1);
    let repo = git.getRepository(vscode.Uri.file(root));
    const discoveryDeadline = Date.now() + 30_000;
    while (!repo) {
        if (Date.now() > discoveryDeadline) { throw new Error("Git fixture repository was not discovered"); }
        await new Promise((resolve) => setTimeout(resolve, 100));
        repo = git.getRepository(vscode.Uri.file(root));
    }
    if (process.env.BGV_UI_SCROLL === "1") {
        await vscode.workspace.getConfiguration("editor").update("wordWrap", "on", vscode.ConfigurationTarget.Global);
        const file = path.join(root, "committed/tall_e.txt");
        const content = fs.readFileSync(file, "utf8").split("\n");
        for (let i = 10; i <= 219; i++) { content[i] = `changed row ${i} ${"wrapped text ".repeat(i % 4)}`; }
        for (const line of [225, 229, 233]) { content[line] = `nearby short change ${line}`; }
        fs.writeFileSync(file, content.join("\n"));
        await repo.status();
        await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(file));
        await new Promise(resolve => setTimeout(resolve, 500));
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file && e.document.uri.scheme === "file")!;
        assert.ok(editor, "Scroll fixture must have a visible modified editor");
        const start = new vscode.Position(219, 0);
        editor.selection = new vscode.Selection(start, start);
        editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
        await new Promise(resolve => setTimeout(resolve, 200));
        await vscode.commands.executeCommand("workbench.view.scm");
        let tops = [editor.visibleRanges[0].start.line];
        let carets = [219];
        const visible = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
            if (event.textEditor === editor) { tops.push(editor.visibleRanges[0].start.line); }
        });
        const selected = vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor === editor) {
                carets.push(editor.selection.active.line);
                console.log(`COMPUTER_USE_SCROLL caret=${editor.selection.active.line} top=${editor.visibleRanges[0].start.line}`);
            }
        });
        const waitForCaret = async (line: number) => {
            const deadline = Date.now() + 240_000;
            while (editor.selection.active.line !== line) {
                if (Date.now() > deadline) { throw new Error(`Timed out waiting for Computer Use caret ${line}`); }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        };
        try {
            console.log("COMPUTER_USE_WAIT press Next three times, then wait for forward verification");
            await waitForCaret(233);
            assert.deepStrictEqual([...new Set(carets)], [219, 225, 229, 233]);
            assert.ok(tops.every((top, index) => index === 0 || top >= tops[index - 1]), `Next reversed: ${tops}`);
            console.log(`COMPUTER_USE_VERIFIED Next carets=${carets} tops=${tops}`);
            tops = [editor.visibleRanges[0].start.line];
            carets = [233];
            console.log("COMPUTER_USE_WAIT press Previous twice");
            await waitForCaret(225);
            assert.deepStrictEqual([...new Set(carets)], [233, 229, 225]);
            assert.ok(tops.every((top, index) => index === 0 || top <= tops[index - 1]), `Previous reversed: ${tops}`);
            console.log(`BETTER_GIT_COMPUTER_USE_SCROLL_VERIFIED Previous carets=${carets} tops=${tops}`);
        } finally {
            visible.dispose();
            selected.dispose();
        }
        return;
    }
    const a = "committed/mod_a.txt";
    const b = "committed/mod_d.txt";
    fs.appendFileSync(path.join(root, a), "Computer Use change A\n");
    fs.appendFileSync(path.join(root, b), "Computer Use change B\n");
    await repo.status();
    await api.whenStageTransactionsSettled();
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(path.join(root, a)));
    const staged = (): string[] => execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root, encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
        const deadline = Date.now() + 240_000;
        console.log(`COMPUTER_USE_WAIT ${label}`);
        while (!predicate()) {
            if (Date.now() > deadline) { throw new Error(`Computer Use timed out: ${label}`); }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        console.log(`COMPUTER_USE_VERIFIED ${label}`);
    };
    await waitFor(() => staged().includes(a), "stage file A through the UI");
    await waitFor(() => staged().includes(b), "stage file B through the UI");
    await waitFor(() => staged().includes(a) && !staged().includes(b), "first SCM Cmd+Z unstages only B");
    await waitFor(() => staged().length === 0, "second SCM Cmd+Z unstages A");
    assert.ok(fs.readFileSync(path.join(root, a), "utf8").includes("Computer Use change A"));
    assert.ok(fs.readFileSync(path.join(root, b), "utf8").includes("Computer Use change B"));
    console.log("BETTER_GIT_COMPUTER_USE_VERIFIED working-files-preserved=true");
}
