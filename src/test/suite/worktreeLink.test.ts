import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { runWithTransientGitIndexRetry } from '../../gitIndexRetry';

suite('Worktree link E2E', () => {
    let root: string;
    let target: string;
    let git: any;
    let api: any;
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    const resetTarget = () => runWithTransientGitIndexRetry(async () => runGit(target, 'reset', '--hard', 'HEAD'));
    const activePath = () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputTextDiff ? input.modified.fsPath
            : input instanceof vscode.TabInputText ? input.uri.fsPath : undefined;
    };
    suiteSetup(async () => {
        // The launcher owns this temporary parent until the host exits. Keep these repositories outside
        // EVERY workspace folder: a nested repository is not equivalent to a footer-opened worktree.
        assert.ok(process.env.BGV_REVEAL_WORKTREE_PATH, 'Run with --grep or --all for the external fixture');
        root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(process.env.BGV_REVEAL_WORKTREE_PATH!), 'bgv-link-')));
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
        api = await vscode.extensions.getExtension('EthanSK.better-git-vscode')!.activate();
        console.log(`Worktree link host: VS Code ${vscode.version}`);
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
    test('link recursively collapses once per invocation with startup automation off', async () => {
        const config = vscode.workspace.getConfiguration('better-git-vscode');
        const beforeSetting = config.inspect<boolean>('experimentalScmTreeStateManagement')?.workspaceValue;
        try {
            await config.update('experimentalScmTreeStateManagement', false, vscode.ConfigurationTarget.Workspace);
            const before = api.getScmTreeCommandTrace().length;
            for (let i = 0; i < 2; i++) {
                await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
                assert.strictEqual(activePath(), path.join(target, 'review.txt'));
            }
            assert.deepStrictEqual(api.getScmTreeCommandTrace().slice(before), [
                'workbench.view.scm', 'workbench.scm.focus', 'list.collapseAll', 'list.clear',
                'workbench.view.scm', 'workbench.scm.focus', 'list.collapseAll', 'list.clear',
            ]);
        } finally {
            await config.update('experimentalScmTreeStateManagement', beforeSetting, vscode.ConfigurationTarget.Workspace);
        }
    });
    test('a link with Auto Reveal disabled leaves repository expansion alone', async () => {
        const config = vscode.workspace.getConfiguration('scm');
        const previous = config.inspect<boolean>('autoReveal')?.workspaceValue;
        try {
            await config.update('autoReveal', false, vscode.ConfigurationTarget.Workspace);
            const before = api.getScmTreeCommandTrace().length;
            await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
            assert.strictEqual(activePath(), path.join(target, 'review.txt'));
            assert.deepStrictEqual(api.getScmTreeCommandTrace().slice(before), []);
        } finally {
            await config.update('autoReveal', previous, vscode.ConfigurationTarget.Workspace);
        }
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
        const traceStart = api.getScmTreeCommandTrace().length;
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', { rootUri: vscode.Uri.file(root) });
        assert.strictEqual(activePath(), before);
        const repositories = git.repositories.map((repo: any) => repo.rootUri.fsPath).sort();
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', { rootUri: vscode.Uri.file(path.join(root, 'missing')) });
        assert.strictEqual(activePath(), before);
        assert.deepStrictEqual(git.repositories.map((repo: any) => repo.rootUri.fsPath).sort(), repositories);
        assert.deepStrictEqual(api.getScmTreeCommandTrace().slice(traceStart), []);
    });
    for (const command of ['stage-current-file-and-advance', 'stage-and-next-changed-file']) {
        test(`link-opened review: ${command} stages the highlighted file and opens the next`, async () => {
            await resetTarget();
            fs.writeFileSync(path.join(target, 'review.txt'), 'changed again\n');
            fs.writeFileSync(path.join(target, 'zz-next.txt'), 'next file\n');
            const mainBefore = runGit(root, 'status', '--porcelain=v1');
            await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
            assert.strictEqual(activePath(), path.join(target, 'review.txt'));
            await vscode.commands.executeCommand(`better-git-vscode.${command}`);
            assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), 'review.txt');
            assert.strictEqual(activePath(), path.join(target, 'zz-next.txt'), 'Stage must advance from the link-opened file');
            assert.strictEqual(runGit(root, 'status', '--porcelain=v1'), mainBefore);
        });
    }
    for (const source of ['corsair', 'razer']) {
        for (const direction of ['next', 'previous']) {
            test(`link-opened hold release: ${source} ${direction} advances, moves fire and undoes`, async () => {
                await resetTarget();
                fs.writeFileSync(path.join(target, 'review.txt'), 'held change\n');
                fs.writeFileSync(path.join(target, 'zz-next.txt'), 'next file\n');
                await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
                // Repeat the link with its diff already active, as when returning to a task footer.
                await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
                await api.whenReviewDecorationSettled();
                const first = vscode.Uri.file(path.join(target, 'review.txt'));
                const next = vscode.Uri.file(path.join(target, 'zz-next.txt'));
                assert.strictEqual(api.getReviewDecorationBadge(first), '🔥🔥');
                await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', source);
                assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only'), '', 'Hold must not stage');
                await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', source);
                await vscode.commands.executeCommand(`better-git-vscode.stage-and-${direction}-changed-file`);
                await api.whenReviewDecorationSettled();
                assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), 'review.txt');
                assert.strictEqual(activePath(), next.fsPath);
                assert.strictEqual(api.getReviewDecorationBadge(first), undefined);
                assert.strictEqual(api.getReviewDecorationBadge(next), '🔥🔥');
                await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
                await api.whenReviewDecorationSettled();
                assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only'), '');
                assert.strictEqual(activePath(), first.fsPath);
                assert.strictEqual(api.getReviewDecorationBadge(first), '🔥🔥');
                assert.strictEqual(fs.readFileSync(first.fsPath, 'utf8'), 'held change\n');
            });
        }
    }
    for (const kind of ['partially staged text', 'partially staged image', 'deleted', 'new']) {
        test(`link-opened ${kind}: release stages exactly that file and opens the next`, async () => {
            await resetTarget();
            runGit(target, 'clean', '-fd');
            const firstName = kind === 'partially staged image' ? '00-first.png' : kind === 'new' ? '00-new.txt' : 'review.txt';
            const first = vscode.Uri.file(path.join(target, firstName));
            const next = vscode.Uri.file(path.join(target, 'zz-next.txt'));
            if (kind === 'partially staged image') {
                fs.writeFileSync(first.fsPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlqB9sAAAAASUVORK5CYII=', 'base64'));
                runGit(target, 'add', firstName);
                fs.writeFileSync(first.fsPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'));
            } else if (kind === 'deleted') {
                fs.unlinkSync(first.fsPath);
            } else {
                fs.writeFileSync(first.fsPath, 'first change\n');
                if (kind === 'partially staged text') {
                    runGit(target, 'add', firstName);
                    fs.appendFileSync(first.fsPath, 'unstaged change\n');
                }
            }
            if (kind !== 'deleted') { fs.writeFileSync(next.fsPath, 'next file\n'); }
            await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
            await api.whenReviewDecorationSettled();
            assert.strictEqual(api.getCurrentReviewUri(), first.toString());
            if (kind === 'deleted') {
                // The link prefers existing files; make the next entry after it opens the deletion fallback.
                fs.writeFileSync(next.fsPath, 'next file\n');
                await git.getRepository(first).status();
            }
            await vscode.commands.executeCommand('better-git-vscode.stage-hold-ready', 'corsair');
            await vscode.commands.executeCommand('better-git-vscode.stage-hold-clear', 'corsair');
            await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
            await api.whenReviewDecorationSettled();
            assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), firstName);
            assert.strictEqual(activePath(), next.fsPath);
            assert.strictEqual(api.getReviewDecorationBadge(next), '🔥🔥');
            if (kind === 'deleted') { assert.ok(!fs.existsSync(first.fsPath)); }
        });
    }
    test('link-opened rapid hold releases consume two files in order', async () => {
        await resetTarget();
        runGit(target, 'clean', '-fd');
        fs.writeFileSync(path.join(target, 'review.txt'), 'first\n');
        fs.writeFileSync(path.join(target, 'yy-second.txt'), 'second\n');
        fs.writeFileSync(path.join(target, 'zz-third.txt'), 'third\n');
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
        await Promise.all([
            vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file'),
            vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file'),
        ]);
        assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), 'review.txt\nyy-second.txt');
        assert.strictEqual(activePath(), path.join(target, 'zz-third.txt'));
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), 'review.txt');
        assert.strictEqual(activePath(), path.join(target, 'yy-second.txt'));
        await vscode.commands.executeCommand('better-git-vscode.undo-last-stage-and-advance');
        assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only'), '');
        assert.strictEqual(activePath(), path.join(target, 'review.txt'));
    });
    test('switching worktrees during a slow stage preserves the new selection and cancels queued releases', async () => {
        await resetTarget();
        runGit(target, 'clean', '-fd');
        fs.writeFileSync(path.join(target, 'review.txt'), 'first\n');
        fs.writeFileSync(path.join(target, 'zz-next.txt'), 'next\n');
        fs.writeFileSync(path.join(root, 'review.txt'), 'other worktree\n');
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
        const prototype = Object.getPrototypeOf(git.getRepository(vscode.Uri.file(target)));
        const original = prototype.add;
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        prototype.add = async function (...args: any[]) {
            if (this.rootUri.fsPath === target) { entered(); await gate; }
            return original.apply(this, args);
        };
        let stages: Promise<unknown>[] = [];
        try {
            stages = [
                Promise.resolve(vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file')),
                Promise.resolve(vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file')),
            ];
            await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Stage did not reach Git')), 5000))]);
            await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(root));
            release();
            await Promise.all(stages);
            assert.strictEqual(activePath(), path.join(root, 'review.txt'));
            assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), 'review.txt');
            assert.strictEqual(runGit(root, 'diff', '--cached', '--name-only'), '');
        } finally {
            release();
            await Promise.allSettled(stages);
            prototype.add = original;
            fs.writeFileSync(path.join(root, 'review.txt'), 'base\n');
        }
    });
    test('the last file closes without queued releases staging an older editor from another worktree', async () => {
        await resetTarget();
        runGit(target, 'clean', '-fd');
        fs.writeFileSync(path.join(root, 'review.txt'), 'other worktree\n');
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'review.txt')), { preview: false });
        fs.writeFileSync(path.join(target, 'review.txt'), 'last file\n');
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
        await Promise.all(Array.from({ length: 3 }, () => vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file')));
        assert.strictEqual(runGit(target, 'diff', '--cached', '--name-only').trim(), 'review.txt');
        assert.strictEqual(runGit(root, 'diff', '--cached', '--name-only'), '');
        assert.notStrictEqual(activePath(), path.join(target, 'review.txt'));
        fs.writeFileSync(path.join(root, 'review.txt'), 'base\n');
    });
    test('a staged-only link ignores hold-to-stage and preserves its index', async () => {
        await resetTarget();
        runGit(target, 'clean', '-fd');
        fs.writeFileSync(path.join(target, 'review.txt'), 'staged only\n');
        runGit(target, 'add', 'review.txt');
        const traceStart = api.getScmTreeCommandTrace().length;
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
        assert.deepStrictEqual(api.getScmTreeCommandTrace().slice(traceStart), [], 'Keep Git-only fallback repositories visible');
        const before = runGit(target, 'diff', '--cached', '--binary');
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
        assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab);
        assert.strictEqual(runGit(target, 'diff', '--cached', '--binary'), before);
    });
    for (const treeView of [false, true]) {
        for (const kind of ['modified', 'untracked', 'deleted']) {
            test(`the link opens the top unstaged ${kind} in ${treeView ? 'tree' : 'list'} review order and staging advances`, async () => {
                await resetTarget();
                runGit(target, 'clean', '-fd');
                const base = runGit(target, 'rev-parse', 'HEAD').trim();
                const config = vscode.workspace.getConfiguration('better-git-vscode');
                const previous = config.inspect<boolean>('treeView')?.workspaceValue;
                const files = ['.notes/findings.md', 'item-2.txt', 'item-10.txt'];
                try {
                    for (const file of files) {
                        fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
                        fs.writeFileSync(path.join(target, file), 'base\n');
                    }
                    runGit(target, 'add', '.');
                    runGit(target, 'commit', '-m', 'ordering fixture');
                    for (const file of files) { fs.writeFileSync(path.join(target, file), 'changed\n'); }
                    const first = treeView ? files[0] : files[1];
                    if (kind === 'untracked') { runGit(target, 'rm', '--cached', first); }
                    if (kind === 'deleted') { fs.unlinkSync(path.join(target, first)); }
                    await config.update('treeView', treeView, vscode.ConfigurationTarget.Workspace);
                    const before = runGit(target, 'status', '--porcelain=v1');
                    await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
                    await api.whenReviewDecorationSettled();
                    assert.strictEqual(api.getCurrentReviewUri(), vscode.Uri.file(path.join(target, first)).toString());
                    assert.strictEqual(runGit(target, 'status', '--porcelain=v1'), before, 'opening the link must not mutate Git');
                    await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
                    assert.strictEqual(activePath(), path.join(target, treeView ? files[1] : files[2]));
                    assert.strictEqual(runGit(target, 'diff', '--name-only').split('\n').includes(first), false);
                } finally {
                    await config.update('treeView', previous, vscode.ConfigurationTarget.Workspace);
                    await runWithTransientGitIndexRetry(async () => runGit(target, 'reset', '--hard', base));
                    runGit(target, 'clean', '-fd');
                }
            });
        }
    }
    for (const stagedBase of [false, true]) {
        test(`repeated ${stagedBase ? 'modified' : 'new'} image links change editor inputs for native reveal`, async () => {
            await resetTarget();
            runGit(target, 'clean', '-fd');
            const image = vscode.Uri.file(path.join(target, '00-repeat.png'));
            fs.writeFileSync(image.fsPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlqB9sAAAAASUVORK5CYII=', 'base64'));
            if (stagedBase) {
                runGit(target, 'add', '00-repeat.png');
                fs.writeFileSync(image.fsPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'));
            }
            await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
            const before = runGit(target, 'status', '--porcelain=v1');
            let changes = 0;
            const listener = vscode.window.tabGroups.onDidChangeTabs(() => { changes++; });
            try {
                await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
                await api.whenReviewDecorationSettled();
                assert.ok(changes > 0, 'Repeat must change the custom/image editor input');
                assert.strictEqual(api.getCurrentReviewUri(), image.toString());
                assert.strictEqual(runGit(target, 'status', '--porcelain=v1'), before);
            } finally { listener.dispose(); }
        });
    }
    test('the link prefers an unstaged deletion over an already-staged file', async () => {
        await resetTarget();
        runGit(target, 'clean', '-fd');
        fs.writeFileSync(path.join(target, '00-staged.txt'), 'already staged\n');
        runGit(target, 'add', '00-staged.txt');
        fs.unlinkSync(path.join(target, 'review.txt'));
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(target));
        await api.whenReviewDecorationSettled();
        assert.strictEqual(api.getCurrentReviewUri(), vscode.Uri.file(path.join(target, 'review.txt')).toString());
        await vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file');
        assert.strictEqual(runGit(target, 'diff', '--name-only'), '');
        assert.strictEqual(runGit(target, 'show', ':00-staged.txt'), 'already staged\n');
    });
    test('a newly opened conflict stages and advances even when an exact Undo snapshot is unavailable', async () => {
        const conflicted = path.join(path.dirname(root), 'conflicted-worktree');
        fs.mkdirSync(conflicted);
        runGit(conflicted, 'init', '-b', 'main');
        runGit(conflicted, 'config', 'user.email', 'test@local.invalid');
        runGit(conflicted, 'config', 'user.name', 'Link test');
        runGit(conflicted, 'config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(conflicted, 'conflict.txt'), 'base\n');
        runGit(conflicted, 'add', '.');
        runGit(conflicted, 'commit', '-m', 'base');
        fs.writeFileSync(path.join(conflicted, '00-staged.txt'), 'already staged\n');
        runGit(conflicted, 'add', '00-staged.txt');
        const blob = (text: string) => execFileSync('git', ['-C', conflicted, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim();
        const entries = ['base\n', 'ours\n', 'theirs\n'].map((text, index) => `100644 ${blob(text)} ${index + 1}\tconflict.txt\n`).join('');
        runGit(conflicted, 'update-index', '--force-remove', 'conflict.txt');
        execFileSync('git', ['-C', conflicted, 'update-index', '--index-info'], { input: entries });
        fs.writeFileSync(path.join(conflicted, 'conflict.txt'), 'resolved working text\n');
        await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control', vscode.Uri.file(conflicted));
        assert.strictEqual(activePath(), path.join(conflicted, 'conflict.txt'), 'Open the remaining conflict, not the staged file');
        fs.writeFileSync(path.join(conflicted, 'zz-next.txt'), 'next\n');
        await git.getRepository(vscode.Uri.file(conflicted)).status();
        await Promise.race([
            vscode.commands.executeCommand('better-git-vscode.stage-and-next-changed-file'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Stage waited for the Undo warning to be dismissed')), 3000)),
        ]);
        assert.strictEqual(activePath(), path.join(conflicted, 'zz-next.txt'));
        assert.strictEqual(runGit(conflicted, 'ls-files', '-u'), '');
        assert.strictEqual(runGit(conflicted, 'show', ':conflict.txt'), 'resolved working text\n');
    });
});
