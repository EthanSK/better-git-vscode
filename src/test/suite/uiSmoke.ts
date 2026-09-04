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
