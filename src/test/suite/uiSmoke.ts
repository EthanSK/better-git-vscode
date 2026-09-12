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
            ...(process.env.BGV_UI_STAGE_READY === "1" ? ["--focus"] : []),
        ], { encoding: "utf8", timeout: 20000 }));
    }
    const worktreeLink = process.env.BGV_UI_WORKTREE_LINK === "1";
    const root = worktreeLink ? process.env.BGV_REVEAL_WORKTREE_PATH! : vscode.workspace.workspaceFolders![0].uri.fsPath;
    assert.ok(root, "Worktree link UI mode requires --grep fixtures");
    const extension = vscode.extensions.getExtension<any>("EthanSK.better-git-vscode")!;
    const api = await extension.activate();
    const gitExtension = vscode.extensions.getExtension<any>("vscode.git")!;
    const git = (await gitExtension.activate()).getAPI(1);
    let repo = git.getRepository(vscode.Uri.file(root)) ?? await git.openRepository(vscode.Uri.file(root));
    const discoveryDeadline = Date.now() + 30_000;
    while (!repo) {
        if (Date.now() > discoveryDeadline) { throw new Error("Git fixture repository was not discovered"); }
        await new Promise((resolve) => setTimeout(resolve, 100));
        repo = git.getRepository(vscode.Uri.file(root));
    }
    if (process.env.BGV_UI_SCROLL === "1") {
        const spam = process.env.BGV_UI_SPAM === "1";
        await vscode.workspace.getConfiguration("editor").update("wordWrap", spam ? "off" : "on", vscode.ConfigurationTarget.Global);
        const file = path.join(root, "committed/tall_e.txt");
        const content = fs.readFileSync(file, "utf8").split("\n");
        if (spam) {
            content.splice(10, 240, ...Array.from({ length: 1000 }, (_, i) => `changed row ${i}`));
        } else {
            for (let i = 10; i <= 219; i++) { content[i] = `changed row ${i} ${"wrapped text ".repeat(i % 4)}`; }
            for (const line of [225, 229, 233]) { content[line] = `nearby short change ${line}`; }
        }
        fs.writeFileSync(file, content.join("\n"));
        await repo.status();
        await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(file));
        await new Promise(resolve => setTimeout(resolve, 500));
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file && e.document.uri.scheme === "file")!;
        assert.ok(editor, "Scroll fixture must have a visible modified editor");
        const start = new vscode.Position(spam ? 30 : 219, 0);
        editor.selection = new vscode.Selection(start, start);
        editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
        await new Promise(resolve => setTimeout(resolve, 200));
        await vscode.commands.executeCommand("workbench.view.scm");
        let tops = [editor.visibleRanges[0].start.line];
        let carets = [start.line];
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
            console.log(`COMPUTER_USE_WAIT press Next ${spam ? '30' : 'three'} times, then wait for forward verification`);
            await waitForCaret(spam ? 330 : 233);
            assert.deepStrictEqual([...new Set(carets)], spam ? Array.from({ length: 31 }, (_, i) => 30 + i * 10) : [219, 225, 229, 233]);
            assert.ok(tops.every((top, index) => index === 0 || top >= tops[index - 1]), `Next reversed: ${tops}`);
            console.log(`COMPUTER_USE_VERIFIED Next carets=${carets} tops=${tops}`);
            tops = [editor.visibleRanges[0].start.line];
            carets = [spam ? 330 : 233];
            console.log(`COMPUTER_USE_WAIT press Previous ${spam ? '20 times' : 'twice'}`);
            await waitForCaret(spam ? 130 : 225);
            assert.deepStrictEqual([...new Set(carets)], spam ? Array.from({ length: 21 }, (_, i) => 330 - i * 10) : [233, 229, 225]);
            assert.ok(tops.every((top, index) => index === 0 || top <= tops[index - 1]), `Previous reversed: ${tops}`);
            console.log(`BETTER_GIT_COMPUTER_USE_SCROLL_VERIFIED Previous carets=${carets} tops=${tops}`);
        } finally {
            visible.dispose();
            selected.dispose();
        }
        return;
    }
    const a = worktreeLink ? "firestore.indexes.json" : "committed/mod_a.txt";
    const b = worktreeLink ? "firestore.rules.template" : "committed/mod_d.txt";
    const c = worktreeLink ? ".notes/findings.md" : "committed/yy_third.txt";
    const d = worktreeLink ? ".notes/zz_fourth.txt" : "committed/zz_fourth.txt";
    if (worktreeLink) {
        // Reproduce raw Git order starting inside a dot-directory while SCM's list starts with root files.
        for (const relative of [a, b, c, d]) {
            fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
            fs.writeFileSync(path.join(root, relative), "base\n");
        }
        execFileSync("git", ["add", "--", a, b, c, d], { cwd: root });
        execFileSync("git", ["commit", "-m", "Worktree ordering fixture"], { cwd: root });
    }
    fs.appendFileSync(path.join(root, a), "Computer Use change A\n");
    fs.appendFileSync(path.join(root, b), "Computer Use change B\n");
    if (worktreeLink) {
        fs.writeFileSync(path.join(root, c), "Computer Use change C\n");
        fs.writeFileSync(path.join(root, d), "Computer Use change D\n");
    }
    await repo.status();
    await api.whenStageTransactionsSettled();
    if (worktreeLink) {
        // The operator delivers the real URI to this isolated profile; the harness must not call the
        // handler directly or manufacture its focus/selection state before testing mouse shortcuts.
        if (process.env.BGV_UI_COLLAPSE_OTHERS === "1") {
            // Task-owned peers make the native collapsed-header result visible with a nontrivial list.
            for (let i = 1; i <= 8; i++) {
                const peer = path.join(path.dirname(root), `collapse-peer-${i}`);
                execFileSync("git", ["worktree", "add", "--detach", peer], { cwd: root });
                fs.writeFileSync(path.join(peer, "peer-change.txt"), `peer ${i}\n`);
                await (await git.openRepository(vscode.Uri.file(peer))).status();
            }
            await vscode.commands.executeCommand("workbench.view.scm");
            await vscode.commands.executeCommand("workbench.scm.action.expandAllRepositories");
            await vscode.commands.executeCommand("workbench.scm.history.focus");
            console.log("COMPUTER_USE_COLLAPSE_PEERS_READY count=8 graph-focused=true");
        }
        console.log(`COMPUTER_USE_WORKTREE_LINK root=${root} vscode=${vscode.version}`);
    } else {
        await vscode.commands.executeCommand("workbench.view.scm");
        await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(path.join(root, a)));
    }
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
    if (worktreeLink) {
        const uri = (relative: string) => vscode.Uri.file(path.join(root, relative));
        await waitFor(() => api.getReviewDecorationBadge(uri(a)) === "🔥🔥", "URI opens A with fire");
        await waitFor(() => api.getReviewDecorationBadge(uri(a)) === "💥💥", "hold A shows readiness");
        assert.deepStrictEqual(staged(), [], "Hold cannot stage before release");
        await waitFor(() => staged().includes(a) && api.getReviewDecorationBadge(uri(b)) === "🔥🔥", "release stages A and selects B with fire");
        await waitFor(() => staged().includes(b) && staged().includes(c) && api.getReviewDecorationBadge(uri(d)) === "🔥🔥", "two rapid releases stage B and C and select D");
        assert.deepStrictEqual(staged(), [a, b, c].sort());
        await waitFor(() => staged().length === 2 && api.getReviewDecorationBadge(uri(c)) === "🔥🔥", "first Undo restores and selects C");
        await waitFor(() => staged().length === 1 && api.getReviewDecorationBadge(uri(b)) === "🔥🔥", "second Undo restores and selects B");
        await waitFor(() => staged().length === 0 && api.getReviewDecorationBadge(uri(a)) === "🔥🔥", "third Undo restores and selects A");
        for (const [relative, text] of [[a, "A"], [b, "B"], [c, "C"], [d, "D"]]) {
            assert.ok(fs.readFileSync(path.join(root, relative), "utf8").includes(`Computer Use change ${text}`));
        }
        if (process.env.BGV_UI_COLLAPSE_OTHERS === "1") {
            const trace = api.getScmTreeCommandTrace();
            assert.ok(trace.length >= 4 && trace.length % 4 === 0);
            for (let i = 0; i < trace.length; i += 4) {
                assert.deepStrictEqual(trace.slice(i, i + 4), ["workbench.view.scm", "workbench.scm.action.collapseAllRepositories", "workbench.scm.focus", "list.clear"]);
            }
            console.log(`COMPUTER_USE_COLLAPSE_TRACE ${JSON.stringify(trace)}`);
        }
        console.log("BETTER_GIT_WORKTREE_HOLD_COMPUTER_USE_VERIFIED uri=true release-advances=true rapid-releases-ordered=true undo=C,B,A working-files-preserved=true");
        return;
    }
    if (process.env.BGV_UI_STAGE_READY === "1") {
        const aUri = vscode.Uri.file(path.join(root, a));
        const bUri = vscode.Uri.file(path.join(root, b));
        await api.whenReviewDecorationSettled();
        await waitFor(() => api.getReviewDecorationBadge(aUri) === "💥💥", "hold A until explosion badge is visible");
        assert.deepStrictEqual(staged(), [], "holding must not stage before release");
        await waitFor(() => staged().includes(a), "release A to stage and advance");
        await waitFor(() => api.getReviewDecorationBadge(bUri) === "💥💥", "hold B until explosion badge is visible");
        assert.deepStrictEqual(staged(), [a], "holding B must not stage it before release");
        await waitFor(() => staged().length === 0, "Undo chord cancels B hold and unstages A");
        assert.ok(!staged().includes(b));
        console.log("BETTER_GIT_STAGE_READY_COMPUTER_USE_VERIFIED readiness-no-index-write=true release-stages=true undo-consumes-hold=true");
        return;
    }
    await waitFor(() => staged().includes(a), "stage file A through the UI");
    await waitFor(() => staged().includes(b), "stage file B through the UI");
    await waitFor(() => staged().includes(a) && !staged().includes(b), "first SCM Cmd+Z unstages only B");
    const showsRestoredDiff = (relativePath: string): boolean => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff && input.modified.scheme === "file"
            && input.modified.fsPath === path.join(root, relativePath);
    };
    await waitFor(() => showsRestoredDiff(b), "first Undo selects restored file B");
    await waitFor(() => staged().length === 0, "second SCM Cmd+Z unstages A");
    await waitFor(() => showsRestoredDiff(a), "second Undo selects restored file A");
    assert.ok(fs.readFileSync(path.join(root, a), "utf8").includes("Computer Use change A"));
    assert.ok(fs.readFileSync(path.join(root, b), "utf8").includes("Computer Use change B"));
    console.log("BETTER_GIT_COMPUTER_USE_VERIFIED working-files-preserved=true undo-selected-files=B,A");
}
