// Opt-in native workbench regression. CDP is confined to this disposable test host;
// Better Git itself neither needs nor connects to a debugging port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertE2EHost } from './e2e-host-guard.mjs';

assertE2EHost();
const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.BGV_VSCODE_EXECUTABLE_PATH;
assert.ok(executable && fs.existsSync(executable), 'Set BGV_VSCODE_EXECUTABLE_PATH to the isolated VS Code executable');
const root = fs.realpathSync(fs.mkdtempSync('/tmp/bgv-native-'));
const evidence = process.env.BGV_NATIVE_EVIDENCE_DIR ?? root;
fs.mkdirSync(evidence, { recursive: true });
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, description, timeout = 15_000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await read(); if (accept(last)) { return last; } } catch (error) { last = String(error); }
        await pause(50);
    }
    throw new Error(`${description}: ${JSON.stringify(last)}`);
}
const roots = Array.from({ length: 9 }, (_, i) => path.join(root, `repo-${i}`));
fs.mkdirSync(roots[0]);
git(roots[0], 'init', '-b', 'main');
for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@local.invalid'], ['commit.gpgsign', 'false']]) {
    git(roots[0], 'config', key, value);
}
for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) { fs.writeFileSync(path.join(roots[0], name), 'base\n'); }
git(roots[0], 'add', '.');
git(roots[0], 'commit', '-m', 'base');
for (const repo of roots.slice(1)) { git(roots[0], 'worktree', 'add', '--detach', repo); }
for (const repo of roots) {
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'existing staged\n');
    git(repo, 'add', 'staged.txt');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) { fs.writeFileSync(path.join(repo, name), 'modified\n'); }
}
// Match the reported busy worktree: 331 staged entries and 395 unstaged entries.
// Keep the first review file unchanged so the existing selection/advance guards still apply.
const largeRepo = roots.at(-1);
for (const [directory, count] of [['bulk-staged', 330], ['bulk-working', 391]]) {
    fs.mkdirSync(path.join(largeRepo, directory));
    for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(largeRepo, directory, `file-${String(i).padStart(3, '0')}.txt`), 'fixture change\n');
    }
}
git(largeRepo, 'add', 'bulk-staged');
fs.writeFileSync(path.join(root, 'roots.json'), JSON.stringify(roots));
const workspace = path.join(root, 'native-worktree.code-workspace');
fs.writeFileSync(workspace, JSON.stringify({ folders: roots.slice(0, -1).map(p => ({ path: p })), settings: {
    'scm.alwaysShowRepositories': true, 'scm.repositories.selectionMode': 'multiple',
    'git.openRepositoryInParentFolders': 'never', 'git.detectWorktrees': false,
    'git.autoRepositoryDetection': false, 'workbench.startupEditor': 'none',
    'better-git-vscode.experimentalScmTreeStateManagement': false,
} }));
const profile = path.join(root, 'profile');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(profile, 'User', 'keybindings.json'), JSON.stringify([
    { key: 'f18', command: 'better-git-vscode.stage-and-next-changed-file' },
    { key: 'f16', command: 'better-git-vscode.undo-last-stage-and-advance' },
    { key: 'cmd+shift+f20', command: 'better-git-vscode.stage-hold-ready', args: 'razer' },
    { key: 'cmd+shift+f15', command: 'better-git-vscode.stage-hold-clear', args: 'razer' },
]));
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const log = fs.openSync(path.join(evidence, 'native-worktree.log'), 'w');
const child = spawn(executable, [workspace, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`,
    `--extensionDevelopmentPath=${extensionRoot}`, `--extensionTestsPath=${path.join(extensionRoot, 'scripts/worktree-native-test-driver.cjs')}`,
    `--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry'],
{ env: { ...process.env, BGV_SWITCH_ROOT: root }, stdio: ['ignore', log, log] });
let socket;
let nextRequest = 0;
async function request(action, extra = {}) {
    const id = ++nextRequest;
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ id, action, ...extra }));
    const result = await until(() => JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')),
        r => r.id === id, `extension request ${action}`);
    assert.equal(result.ok, true, result.error);
    return result;
}
let send;
let evaluate;
const rowsExpression = `[...document.querySelectorAll('[role="treeitem"]')].map(r=>({
    text:r.textContent, aria:r.getAttribute('aria-label'), expanded:r.getAttribute('aria-expanded'),
    level:r.getAttribute('aria-level'), selected:r.getAttribute('aria-selected')}))`;
async function capture(name) {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(result.data, 'base64'));
    fs.writeFileSync(path.join(evidence, `${name}.json`), JSON.stringify(await evaluate(rowsExpression), null, 2));
}
async function check(repo, name, file = 'a.txt') {
    // Wait for the selected file only. Never retry the collapse command: a delayed
    // recollapse would hide the exact regression this test must catch.
    await until(() => evaluate(rowsExpression), rows => rows.some(r => r.selected === 'true' && r.text.includes(`repo-${repo}`) && r.aria?.startsWith(file + ',')), name);
    await pause(350); // Observe late resource publication after the command has returned.
    let rows = await evaluate(rowsExpression);
    if (rows.filter(r => r.level === '1' && /^repo-\d+ Git$/.test(r.aria)).length < roots.length) {
        // A large selected worktree scrolls its preceding repository headers out of the DOM.
        // Inspect the top of the same tree without changing selection or issuing another collapse.
        await capture(`${name}-selected`);
        const point = await evaluate(`(()=>{const tree=document.querySelector('[role="tree"][aria-label="Source Control Management"]');const b=tree.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+Math.min(100,b.height/2)};})()`);
        // Scroll in bounded steps and inspect each resulting viewport.
        for (let i = 0; i < 8; i++) {
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -1000 });
            await pause(100);
            rows = await evaluate(rowsExpression);
            if (rows.filter(r => r.level === '1' && /^repo-\d+ Git$/.test(r.aria)).length === roots.length) { break; }
        }
    }
    await capture(name);
    const repositories = rows.filter(r => r.level === '1' && /^repo-\d+ Git$/.test(r.aria));
    assert.equal(repositories.length, 9, `${name}: missing repository headers`);
    assert.deepEqual(repositories.filter(r => r.expanded === 'true').map(r => r.aria), [`repo-${repo} Git`], `${name}: expanded repositories`);
    assert.equal(rows.find(r => r.aria === 'Staged Changes')?.expanded, 'false', `${name}: Staged Changes remained expanded`);
    assert.equal(rows.find(r => r.aria === 'Changes')?.expanded, 'true', `${name}: Changes must stay expanded`);
    assert.ok(rows.some(r => r.selected === 'true' && r.text.includes(`repo-${repo}`) && r.aria?.startsWith(file + ',')), `${name}: wrong selected file`);
    console.log(`PASS ${name}`);
}
async function key(key, code, virtualKey, modifiers = 0) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
}
try {
    await until(() => fs.existsSync(path.join(root, 'ready.json')), Boolean, 'extension readiness', 45_000);
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t =>
        t.type === 'page' && t.title.includes('[Extension Development Host]') && t.title.includes('native-worktree (Workspace)') && t.url.startsWith('vscode-file:')),
    targets => targets.length === 1, 'owned native workbench');
    socket = new WebSocket(target[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(String(data));
        if (!pending.has(message.id)) { return; }
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id); clearTimeout(timer);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    });
    send = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    evaluate = async expression => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result.value;
    };
    if (process.platform === 'darwin') {
        // Activate only the process launched above, never the user's normal Code.
        execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
            `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`]);
    }
    await send('Page.bringToFront');
    await until(() => request('state'), state => state.focused, 'native window focus');
    await until(() => evaluate(rowsExpression), rows => rows.some(r => r.aria === 'Staged Changes'  && r.expanded === 'true'), 'initial staged group');
    await capture('before-first-open');
    await request('plain', { repo: 0 });
    const graph = await evaluate(`(()=>{const r=[...document.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')==='base, Test'); if(!r)return null; const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    assert.ok(graph, 'visible Source Control Graph commit');
    for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...graph, button: 'left', clickCount: 1 }); }
    await until(() => evaluate(rowsExpression), rows => rows.some(r => r.aria === 'base, Test' && r.selected === 'true'), 'Graph has native selection');
    await capture('graph-focused');
    await request('open', { repo: 8 }); await check(8, 'new-worktree-first-open');
    await request('open', { repo: 0 }); await check(0, 'first-open');
    await request('open', { repo: 0 }); await check(0, 'repeat-open');
    await request('open', { repo: 1 }); await check(1, 'switch-worktree');
    async function expandStagedGroup() {
        const point = await evaluate(`(()=>{const row=[...document.querySelectorAll('[role="treeitem"]')].find(r=>r.getAttribute('aria-label')==='Staged Changes');const r=row.querySelector('.monaco-tl-twistie').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); }
        assert.ok((await evaluate(rowsExpression)).some(r => r.aria === 'Staged Changes' && r.expanded === 'true'));
    }
    await expandStagedGroup();
    await request('command', { command: 'workbench.view.explorer' });
    await request('open', { repo: 1 }); await check(1, 'same-editor-hidden-scm');
    await expandStagedGroup();
    await request('plain', { repo: 0 });
    fs.writeFileSync(path.join(roots[1], 'staged-late.txt'), 'late staged change\n'); git(roots[1], 'add', 'staged-late.txt');
    await request('command', { command: 'workbench.view.explorer' });
    await request('open', { repo: 1 }); await check(1, 'switch-after-staged-refresh');
    // Native keyboard input exercises the mouse protocol's readiness/clear/release
    // command path. Physical mouse hardware itself is outside this harness.
    await key('F20', 'F20', 131, 7);
    await until(() => request('state'), state => state.badge === '💥💥', 'hold readiness badge');
    await pause(150);
    await capture('hold-ready');
    await key('F15', 'F15', 126, 7);
    await until(() => request('state'), state => state.badge === '🔥🔥', 'hold release clears readiness');
    await key('F18', 'F18', 129);
    await check(1, 'stage-and-next', 'b.txt');
    assert.match(git(roots[1], 'diff', '--cached', '--name-only'), /^a.txt$/m);
    await key('F18', 'F18', 129); await key('F18', 'F18', 129);
    await check(1, 'rapid-stage-and-next', 'd.txt');
    for (const file of ['c.txt', 'b.txt', 'a.txt']) { await key('F16', 'F16', 127); await check(1, `undo-to-${file}`, file); }
    assert.deepEqual(git(roots[1], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged-late.txt', 'staged.txt']);
    // Both source transports: navigation happens before release; release stages only the origin.
    for (const [source, modifiers] of [['corsair', 6], ['razer', 12]]) {
        await request('open', { repo: 2 });
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-button-down`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
        await key('F14', 'F14', 125, modifiers); // Short release cancels staging without another navigation.
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-hold-down`, 'c.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '💥💥', 'origin readiness badge');
        assert.equal((await request('state')).badge, '🔥🔥', 'destination must not look ready to stage');
        await capture(`${source}-origin-ready`);
        await pause(1100);
        await key('F18', 'F18', 129, modifiers);
        await key('F15', 'F15', 126, source === 'corsair' ? 7 : 12);
        await until(() => git(roots[2], 'diff', '--cached', '--name-only'), names => names.includes('b.txt'), 'long release stages original');
        await check(2, `${source}-hold-release`, 'c.txt');
        await key('F16', 'F16', 127);
        await check(2, `${source}-undo-origin`, 'b.txt');
        await key('F17', 'F17', 128, modifiers);
        await check(2, `${source}-previous-down`, 'a.txt');
        await key('F19', 'F19', 130, modifiers);
        await until(() => git(roots[2], 'diff', '--cached', '--name-only'), names => names.includes('b.txt'), 'previous release stages original');
        await key('F16', 'F16', 127);
        await check(2, `${source}-previous-undo`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
    }
    for (const repo of roots) for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
        assert.equal(fs.readFileSync(path.join(repo, file), 'utf8'), 'modified\n');
    }
    console.log(`BETTER_GIT_NATIVE_WORKTREE_VERIFIED evidence=${evidence}`);
} finally {
    if (fs.existsSync(path.join(root, 'ready.json'))) { await request('stop').catch(() => {}); }
    socket?.close();
    child.kill('SIGTERM');
    fs.closeSync(log);
    console.log(`Native test fixture: ${root}`);
}
