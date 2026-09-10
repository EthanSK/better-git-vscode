import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';

suite('Worktree link E2E', () => {
    let root: string;
    let target: string;
    let git: any;
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    const activePath = () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff ? input.modified.fsPath
            : input instanceof vscode.TabInputText ? input.uri.fsPath : undefined;
    };
    suiteSetup(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders![1].uri.fsPath, 'bgv-link-')));
        target = path.join(root, 'outside worktree + % #');
        runGit(root, 'init', '-b', 'main');
        runGit(root, 'config', 'user.email', 'test@local.invalid');
        runGit(root, 'config', 'user.name', 'Link test');
        runGit(root, 'config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(root, 'review.txt'), 'base\n');
        runGit(root, 'add', '.');
        runGit(root, 'commit', '-m', 'base');
        runGit(root, 'worktree', 'add', '-b', 'target', target);
        fs.writeFileSync(path.join(target, 'review.txt'), 'changed\n');
        git = (await vscode.extensions.getExtension<any>('vscode.git')!.activate()).getAPI(1);
        await vscode.extensions.getExtension('EthanSK.better-git-vscode')!.activate();
    });
    test('opens the exact outside worktree without replacing workspace folders or modifying Git', async () => {
        const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString());
        const before = runGit(target, 'status', '--porcelain=v1');
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
        assert.strictEqual(activePath(), path.join(target, 'review.txt'));
        assert.deepStrictEqual(vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()), folders);
        assert.strictEqual(runGit(target, 'status', '--porcelain=v1'), before);
        assert.strictEqual(fs.readFileSync(path.join(target, 'review.txt'), 'utf8'), 'changed\n');
    });
    test('repeated opening the same diff emits the editor change required for SCM reveal', async () => {
        let changes = 0;
        const listener = vscode.window.tabGroups.onDidChangeTabs(() => { changes++; });
        try {
            await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', { rootUri: vscode.Uri.file(target) });
            assert.strictEqual(activePath(), path.join(target, 'review.txt'));
            assert.ok(changes > 0, 'same diff must change inputs so VS Code can reveal its row again');
        } finally { listener.dispose(); }
    });
    test('reuses an already opened worktree through a filesystem alias', async () => {
        const actual = path.join(path.dirname(root), 'alias-actual');
        const alias = path.join(path.dirname(root), 'alias-link');
        fs.mkdirSync(actual);
        runGit(actual, 'init', '-b', 'main');
        fs.writeFileSync(path.join(actual, 'new.txt'), 'new file\n');
        fs.symlinkSync(actual, alias, 'dir');
        const repository = await git.openRepository(vscode.Uri.file(alias));
        assert.ok(repository);
        await repository.status();
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(alias));
        assert.ok(activePath());
        assert.strictEqual(fs.realpathSync(activePath()!), path.join(actual, 'new.txt'));
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(actual));
        assert.strictEqual(fs.realpathSync(activePath()!), path.join(actual, 'new.txt'));
    });
    test('copies a chat-compatible link for the selected header, including path punctuation', async () => {
        const previous = await vscode.env.clipboard.readText();
        let copied = '';
        try {
            await vscode.commands.executeCommand('better-git-vscode.copy-worktree-link', { rootUri: vscode.Uri.file(target) });
            copied = await vscode.env.clipboard.readText();
            const wrapper = new URL(copied);
            assert.strictEqual(wrapper.origin, 'https://vscode.dev');
            const uri = new URL(decodeURIComponent(wrapper.searchParams.get('url')!));
            assert.strictEqual(uri.hostname, 'ethansk.better-git-vscode');
            assert.strictEqual(uri.searchParams.get('path'), target);
        } finally {
            if (copied && await vscode.env.clipboard.readText() === copied) { await vscode.env.clipboard.writeText(previous); }
        }
    });
    test('a clean worktree and invalid path do not fall back to a different repository', async () => {
        const before = activePath();
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', { rootUri: vscode.Uri.file(root) });
        assert.strictEqual(activePath(), before);
        const repositories = git.repositories.map((repo: any) => repo.rootUri.fsPath).sort();
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', { rootUri: vscode.Uri.file(path.join(root, 'missing')) });
        assert.strictEqual(activePath(), before);
        assert.deepStrictEqual(git.repositories.map((repo: any) => repo.rootUri.fsPath).sort(), repositories);
    });
});
