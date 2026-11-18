// Isolated Mac Mini check for real URI routing and native diff view commands.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertE2EHost } from './e2e-host-guard.mjs';

assertE2EHost();
const execute = promisify(execFile);
const executable = process.env.BGV_VSCODE_EXECUTABLE_PATH;
assert.ok(executable, 'Set BGV_VSCODE_EXECUTABLE_PATH');
const cli = path.resolve(path.dirname(executable), '../Resources/app/bin/code');
const packagePath = path.resolve(process.argv[2]);
const root = await fs.realpath(await fs.mkdtemp('/tmp/bgv-window-link-'));
const profile = path.join(root, 'profile');
const settingsFile = path.join(profile, 'User/settings.json');
const primary = path.join(root, 'primary');
const review = path.join(root, 'review');
const unopened = path.join(root, 'unopened');
const flags = ['--user-data-dir', profile, '--extensions-dir', path.join(root, 'extensions'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (...args) => execute('git', ['-C', primary, ...args]);
const code = (...args) => execute(cli, [...flags, ...args], { timeout: 15_000 });
const diffMode = 'diffEditor.renderSideBySide';
const settings = {
    'extensions.autoUpdate': false,
    'extensions.confirmedUriHandlerExtensionIds': ['ethansk.better-git-vscode'],
    'git.detectWorktrees': false,
    'git.autoRepositoryDetection': false,
    'scm.alwaysShowRepositories': true,
    'scm.repositories.selectionMode': 'multiple',
    'workbench.startupEditor': 'none',
    'better-git-vscode.debugLogging': true,
    'better-git-vscode.inlineDiffOnDisplay': { uuid: '00000000-0000-0000-0000-000000000000', width: 1, height: 1 },
    'diffEditor.renderSideBySideInlineBreakpoint': 10000,
};
let processHandle;

async function until(label, check) {
    const deadline = Date.now() + 15_000;
    let failure;
    while (Date.now() < deadline) {
        try { if (await check()) { return; } }
        catch (error) { failure = error; }
        await sleep(100);
    }
    throw new Error(`Timed out: ${label}${failure ? ` (${failure.message})` : ''}`);
}

async function logContents() {
    const directory = path.join(profile, 'logs');
    const files = (await fs.readdir(directory, { recursive: true })).filter(name => name.endsWith('Better Git.log'));
    return await Promise.all(files.map(async name => ({ name, text: await fs.readFile(path.join(directory, name), 'utf-8') })));
}

try {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
    await fs.writeFile(path.join(profile, 'User/keybindings.json'), JSON.stringify([
        ['f6', 'better-git-vscode.undo-last-stage-and-advance'], ['f7', 'workbench.action.focusWindow'],
        ['f8', 'diffEditor.setViewMode.sideBySide'], ['f9', 'diffEditor.setViewMode.inline'],
        ['f10', 'better-git-vscode.next-changed-file'], ['f11', 'better-git-vscode.previous-changed-file'],
        ['f12', 'better-git-vscode.stage-and-next-changed-file'],
    ].map(([key, command]) => ({ key: `ctrl+alt+${key}`, command }))));
    await fs.mkdir(primary);
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@local.invalid');
    await git('config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(primary, 'a.txt'), 'base\n');
    await fs.writeFile(path.join(primary, 'b.txt'), 'base\n');
    await git('add', 'a.txt', 'b.txt');
    await git('commit', '-m', 'base');
    await git('worktree', 'add', '--detach', review);
    await git('worktree', 'add', '--detach', unopened);
    for (const folder of [primary, review, unopened]) {
        await fs.writeFile(path.join(folder, 'a.txt'), `working changes in ${path.basename(folder)}\n`);
        await fs.writeFile(path.join(folder, 'b.txt'), `more changes in ${path.basename(folder)}\n`);
        await fs.writeFile(path.join(folder, 'staged.txt'), 'existing staged file\n');
        await execute('git', ['-C', folder, 'add', 'staged.txt']);
    }
    const baselineIndex = (await execute('git', ['-C', review, 'ls-files', '--stage'])).stdout;
    // Primary already knows about the root too, but review is its own window.
    const workspace = path.join(root, 'primary.code-workspace');
    await fs.writeFile(workspace, JSON.stringify({ folders: [primary, review].map(value => ({ path: value })) }));
    assert.match((await code('--install-extension', packagePath)).stdout, /successfully installed/i);
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    processHandle = spawn(executable, [...flags, `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1', workspace], { stdio: 'ignore' });
    const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .filter(page => page.type === 'page' && page.url.endsWith('/workbench.html'));
    const find = (list, name) => list.find(page => page.title === name || page.title.endsWith(` — ${name}`));
    await until('primary renderer', async () => find(await pages(), 'primary (Workspace)') || find(await pages(), 'primary'));
    const primaryPage = (await pages())[0];
    await code('--new-window', review);
    await until('separate review renderer', async () => (await pages()).length === 2);
    const reviewPage = (await pages()).find(page => page.id !== primaryPage.id);

    const cdp = async (page, method, params = {}) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        try {
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 2500);
                ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
                ws.onerror = () => { clearTimeout(timeout); reject(new Error(`${method} failed`)); };
                ws.onmessage = event => {
                    const response = JSON.parse(event.data);
                    if (response.id !== 1) { return; }
                    clearTimeout(timeout);
                    if (response.error) { reject(new Error(response.error.message)); }
                    else { resolve(response.result); }
                };
            });
        } finally { ws.close(); }
    };
    const run = async (page, expression) => (await cdp(page, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const focused = page => run(page, 'document.hasFocus()');
    const press = async (page, number) => {
        const key = { key: `F${number}`, code: `F${number}`, modifiers: 3, windowsVirtualKeyCode: 111 + number };
        await cdp(page, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
        await cdp(page, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    };
    const focusPrimary = async () => {
        await press(primaryPage, 7);
        await until('primary window focused', () => focused(primaryPage));
    };
    const openLink = (folder, origin) => code('--open-url', 'vscode://ethansk.better-git-vscode/open-worktree?path='
        + encodeURIComponent(folder) + (origin ? `&returnTo=${encodeURIComponent(origin)}` : ''));
    const diff = page => run(page, '!!document.querySelector(".monaco-diff-editor")');
    const reviewFile = async name => (await run(reviewPage, 'document.querySelector(".tabs-container .tab.active")?.innerText'))
        ?.includes(name) && await focused(reviewPage) && !await focused(primaryPage);
    const cachedPaths = async () => (await execute('git', ['-C', review, 'diff', '--cached', '--name-only'])).stdout.trim();
    await focusPrimary();
    // Both extension hosts must have started before testing a fresh click into the main window.
    await until('both Better Git extension hosts activated', async () => (await logContents())
        .filter(log => log.text.includes('[activation]')).length === 2);
    await openLink(review);
    await until('the existing review window takes focus and opens its diff', async () => await focused(reviewPage) && await diff(reviewPage));
    assert.strictEqual(await diff(primaryPage), false, 'the receiving window must not open the diff');
    assert.strictEqual((await pages()).length, 2, 'do not create another VS Code window');

    for (const [key, sideBySide] of [[8, true], [9, false], [8, true]]) {
        await press(reviewPage, key);
        await until(`layout ${sideBySide ? 'side by side' : 'inline'} without switching windows`, async () => {
            const cfg = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
            const rendered = await run(reviewPage, 'document.querySelector(".monaco-diff-editor")?.classList.contains("side-by-side")');
            return cfg[diffMode] === sideBySide && rendered === sideBySide && await focused(reviewPage);
        });
        assert.strictEqual(await focused(primaryPage), false);
    }

    // The ordinary review commands must leave the owning window focused too.
    await until('review starts on a.txt', () => reviewFile('a.txt'));
    await press(reviewPage, 10);
    await until('Next Change opens b.txt in the review window', () => reviewFile('b.txt'));
    await press(reviewPage, 11);
    await until('Previous Change returns to a.txt in the review window', () => reviewFile('a.txt'));
    await press(reviewPage, 12);
    await until('Stage and Next stages only a.txt and stays in the review window',
        async () => await reviewFile('b.txt') && await cachedPaths() === 'a.txt\nstaged.txt');
    await press(reviewPage, 6);
    await until('Undo restores a.txt and the original staged set in the review window',
        async () => await reviewFile('a.txt') && await cachedPaths() === 'staged.txt');

    await fs.writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await fs.readFile(settingsFile, 'utf8')),
        'better-git-vscode.worktreeLinkReturnFocus': true, 'better-git-vscode.worktreeLinkKeepEditorFront': true }, null, 2));
    await focusPrimary();
    await openLink(review, 'com.apple.finder');
    await until('Keep Editor Front returns to the review window', () => focused(reviewPage));
    await until('Keep Editor Front acknowledged the origin', async () => (await logContents())
        .some(log => log.text.includes('originActive=true')));
    assert.strictEqual(await diff(primaryPage), false);

    await focusPrimary();
    await openLink(unopened);
    await until('unopened worktree opens in the original window', async () => await focused(primaryPage) && await diff(primaryPage));
    assert.strictEqual((await pages()).length, 2);
    assert.strictEqual((await execute('git', ['-C', review, 'ls-files', '--stage'])).stdout, baselineIndex);
    console.log('BETTER_GIT_WORKTREE_WINDOW_ROUTING_PASSED');
} catch (error) {
    for (const log of await logContents().catch(() => [])) {
        console.error(log.name, log.text.split('\n').filter(line => /\[(activation|worktree-link|worktree-focus)\]/.test(line)).slice(-12).join('\n'));
    }
    throw error;
} finally {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        const ended = new Promise(resolve => processHandle.once('exit', resolve));
        processHandle.kill('SIGTERM');
        await Promise.race([ended, sleep(3500)]);
    }
    if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
        await fs.rm(root, { recursive: true, force: true });
    } else {
        console.error(`Isolated Code is still running: PID ${processHandle.pid} at ${root}`);
        process.exitCode = 1;
    }
}
