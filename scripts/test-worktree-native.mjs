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
const testLinkBackground = process.argv.includes('--link-background');
const testReturnApp = process.argv.includes('--return-app');
const testKeyboardRepeat = process.argv.includes('--keyboard-repeat');
const testHeldClick = process.argv.includes('--held-click');
const testNoUnstaged = process.argv.includes('--no-unstaged');
const testStageReveal = process.argv.includes('--stage-reveal');
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
    // The dedicated Mini uses Dvorak - QWERTY Cmd. Physical X is therefore the contributed Shift+Option+Q
    // binding while still reporting hardware key code 7 to the release monitor.
    'better-git-vscode.dvorakMode': testKeyboardRepeat,
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
let activationMonitor;
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
    assert.equal(rows.find(r => r.aria === 'Staged Changes')?.expanded, 'false', `${name}: Staged Changes remained expanded`);
    const repositories = rows.filter(r => r.level === '1' && /^repo-\d+ Git$/.test(r.aria));
    assert.equal(repositories.length, 9, `${name}: missing repository headers`);
    assert.deepEqual(repositories.filter(r => r.expanded === 'true').map(r => r.aria), [`repo-${repo} Git`], `${name}: expanded repositories`);
    assert.equal(rows.find(r => r.aria === 'Changes')?.expanded, 'true', `${name}: Changes must stay expanded`);
    assert.ok(rows.some(r => r.selected === 'true' && r.text.includes(`repo-${repo}`) && r.aria?.startsWith(file + ',')), `${name}: wrong selected file`);
    console.log(`PASS ${name}`);
}
async function key(key, code, virtualKey, modifiers = 0) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
}
async function repeatedKeyDown(key, code, virtualKey, modifiers, repeatCount) {
    // Send the same keyDown burst VS Code receives from OS auto-repeat. Keep the monitor cold so all repeats
    // queue behind one first press before its asynchronous physical-release probe can settle in this synthetic
    // test (CDP itself does not change CoreGraphics' global key state).
    await Promise.all(Array.from({ length: repeatCount }, (_, index) => send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, autoRepeat: index > 0,
    })));
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
    if (testNoUnstaged) {
        const original = await request('state');
        for (const [repo, kind] of [[2, 'staged'], [2, 'repeat'], [3, 'clean'], [3, 'clean-repeat'], [4, 'deleted'], [8, 'large-staged']]) {
            if (kind === 'clean') { git(roots[repo], 'reset', '--hard', 'HEAD'); }
            else if (kind === 'deleted') {
                git(roots[repo], 'reset', '--hard', 'HEAD');
                for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) { fs.unlinkSync(path.join(roots[repo], file)); }
                git(roots[repo], 'add', '-u');
            } else if (!kind.includes('repeat')) { git(roots[repo], 'add', '.'); }
            await request('refresh', { repo });
            await request('command', { command: 'workbench.scm.action.expandAllRepositories' });
            await request('command', { command: 'workbench.scm.history.focus' });
            const before = roots.map(r => git(r, 'status', '--porcelain=v1'));
            await request('watch-tabs');
            await request('open', { repo });
            await pause(500);
            await capture(`no-unstaged-${kind}`);
            const rows = await evaluate(rowsExpression);
            assert.deepEqual(rows.filter(r => r.level === '1' && /^repo-/.test(r.aria) && r.expanded === 'true').map(r => r.aria), [`repo-${repo} Git`], kind);
            assert.ok(rows.filter(r => r.aria === 'Staged Changes').every(r => r.expanded === 'false'), `${kind}: staged group`);
            assert.ok(!rows.some(r => r.level === '3' && r.selected === 'true'), `${kind}: selected a file`);
            const after = await request('state');
            assert.equal(after.active, original.active, `${kind}: changed editor`);
            assert.deepEqual(after.tabs, original.tabs, `${kind}: changed tabs`);
            assert.deepEqual((await request('watched-tabs')).value, [], `${kind}: transient editor change`);
            assert.deepEqual(roots.map(r => git(r, 'status', '--porcelain=v1')), before, `${kind}: modified Git`);
            console.log(`PASS no-unstaged-${kind}`);
        }
        for (const kind of ['staged', 'clean']) {
            const fresh = path.join(root, `fresh-${kind}`);
            git(roots[0], 'worktree', 'add', '--detach', fresh);
            if (kind === 'staged') {
                fs.writeFileSync(path.join(fresh, 'a.txt'), 'fresh staged\n');
                git(fresh, 'add', 'a.txt');
            }
            const before = git(fresh, 'status', '--porcelain=v1');
            await request('command', { command: 'workbench.scm.history.focus' });
            await request('watch-tabs');
            await request('uri', { uri: `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(fresh)}` });
            await pause(500);
            await capture(`no-unstaged-fresh-${kind}`);
            const rows = await evaluate(rowsExpression);
            assert.ok(rows.some(r => r.aria === `fresh-${kind} Git` && r.expanded === 'true'));
            assert.ok(!rows.some(r => r.level === '1' && r.aria?.endsWith(' Git') && r.aria !== `fresh-${kind} Git` && r.expanded === 'true'));
            assert.ok(rows.filter(r => r.aria === 'Staged Changes').every(r => r.expanded === 'false'));
            assert.deepEqual((await request('watched-tabs')).value, []);
            assert.equal((await request('state')).active, original.active);
            assert.equal(git(fresh, 'status', '--porcelain=v1'), before);
            console.log(`PASS no-unstaged-fresh-${kind}`);
        }
        console.log('BETTER_GIT_NO_UNSTAGED_REVEAL_VERIFIED');
    } else if (testLinkBackground) {
        const jxa = code => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); ${code}`], { encoding: 'utf8' });
        const focusCode = () => jxa(`$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`);
        for (const [repo, delay] of [[2, 1200], [3, 50], [2, 0]]) {
            await request('command', { command: 'workbench.scm.action.expandAllRepositories' });
            await request('plain', { repo: 0 });
            await request('command', { command: 'workbench.scm.history.focus' });
            jxa(`$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').objectAtIndex(0).activateWithOptions(2);`);
            await until(() => request('state'), state => !state.focused, 'Code is background before URI');
            const opening = request('uri', { uri: `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}` });
            await pause(delay);
            focusCode();
            await opening;
            await check(repo, `background-link-${repo}-${delay}`);
        }
        console.log('BETTER_GIT_BACKGROUND_LINK_VERIFIED');
    } else if (testHeldClick) {
        await request('command', { command: 'better-git-vscode.begin-mouse-navigation-hold', args: [{ source: 'corsair', direction: 'next' }] });
        await request('command', { command: 'better-git-vscode.stage-hold-ready', args: ['corsair'] });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        const point = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.part.editor .monaco-editor .view-line')].filter(n=>n.getBoundingClientRect().width>0 && n.textContent.includes('modified'));const r=nodes.at(-1).getBoundingClientRect();return {x:r.x+32,y:r.y+8};})()`);
        for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); }
        await pause(250);
        await capture('held-batch-after-editor-click');
        for (const file of ['a.txt', 'b.txt']) {
            assert.equal((await request('badge', { repo: 1, file })).value, '💥💥', 'left-click must retain the held batch');
        }
        const gutter = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.part.editor .line-numbers')].filter(n=>n.getBoundingClientRect().width>0);const r=nodes.at(-1).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, ...gutter, button: 'left', clickCount: 1 }); }
        await pause(250);
        for (const file of ['a.txt', 'b.txt']) {
            assert.equal((await request('badge', { repo: 1, file })).value, '💥💥', 'gutter click must retain the held batch');
        }
        await capture('held-batch-after-gutter-click');
        await request('plain', { repo: 0, file: 'd.txt', preview: false });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        fs.writeFileSync(path.join(roots[1], 'aa-unselected.txt'), 'background edit\n');
        await request('refresh', { repo: 1 });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'up'] });
        for (const file of ['a.txt', 'b.txt']) { assert.equal((await request('badge', { repo: 1, file })).value, '💥💥'); }
        assert.notEqual((await request('badge', { repo: 1, file: 'c.txt' })).value, '💥💥');
        await capture('held-click-shrunk-group');
        await request('command', { command: 'better-git-vscode.finish-mouse-navigation-hold', args: [{ source: 'corsair', direction: 'next' }] });
        await request('command', { command: 'better-git-vscode.stage-hold-clear', args: ['corsair'] });
        // A delayed mouse-wheel URL must not re-light or mutate the released group.
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        assert.deepEqual(git(roots[1], 'diff', '--cached', '--name-only').trim().split('\n'), ['a.txt', 'b.txt', 'staged-late.txt', 'staged.txt']);
        await until(() => request('state'), state => state.active === 'file://' + roots[1] + '/c.txt', 'release advances in the captured repository');
        await capture('held-click-release');
        await key('F16', 'F16', 127);
        await until(() => git(roots[1], 'diff', '--cached', '--name-only').trim(), value => value === 'staged-late.txt\nstaged.txt', 'one Undo restores the held batch');
        await capture('held-click-batch-undo');
        console.log('BETTER_GIT_HELD_EDITOR_CLICK_VERIFIED');
    } else if (testStageReveal) {
        // Closing a pinned review tab must never activate a staged-only background editor.
        // Its file: URI causes SCM Auto Reveal to expand Staged Changes and scroll the tree.
        await request('plain', { repo: 1, file: 'staged.txt', preview: false });
        await request('open', { repo: 1 });
        await request('command', { command: 'workbench.action.keepEditor' });
        await check(1, 'pinned-review-before-stage');
        await request('watch-tabs');
        await key('F18', 'F18', 129);
        await check(1, 'pinned-review-after-stage', 'b.txt');
        const transitions = (await request('watched-tabs')).value;
        assert.ok(!transitions.some(uri => uri.includes('/staged.txt')), `staged editor flashed: ${JSON.stringify(transitions)}`);
        await request('command', { command: 'workbench.action.keepEditor' });
        await key('F18', 'F18', 129); await key('F18', 'F18', 129);
        await check(1, 'pinned-rapid-stage', 'd.txt');
        for (const file of ['c.txt', 'b.txt', 'a.txt']) {
            await key('F16', 'F16', 127); await check(1, `pinned-undo-${file}`, file);
        }
        await request('plain', { repo: 2, file: 'staged.txt', preview: false });
        await request('open', { repo: 2 });
        await request('working', { repo: 2, file: 'c.txt' });
        await request('command', { command: 'workbench.action.keepEditor' });
        await request('command', { command: 'better-git-vscode.stage-and-previous-changed-file' });
        await check(2, 'pinned-stage-previous', 'b.txt');
        await request('plain', { repo: 3, file: 'staged.txt', preview: false });
        await request('open', { repo: 3 });
        await request('command', { command: 'better-git-vscode.begin-mouse-navigation-hold', args: [{source:'corsair',direction:'next'}] });
        await request('command', { command: 'better-git-vscode.stage-hold-ready', args: ['corsair'] });
        await request('command', { command: 'better-git-vscode.adjust-mouse-stage-selection', args: ['corsair', 'down'] });
        await request('command', { command: 'workbench.action.keepEditor' });
        await request('command', { command: 'better-git-vscode.finish-mouse-navigation-hold', args: [{source:'corsair',direction:'next'}] });
        await check(3, 'pinned-batch-stage', 'c.txt');
        assert.deepEqual(git(roots[3], 'diff', '--cached', '--name-only').trim().split('\n'), ['a.txt','b.txt','staged.txt']);
        await key('F16', 'F16', 127); await check(3, 'pinned-batch-undo', 'a.txt');
        await expandStagedGroup();
        await request('command', { command: 'workbench.action.keepEditor' });
        await key('F18', 'F18', 129);
        await until(() => request('state'), state => state.active.endsWith('/b.txt'), 'stage after manual expansion');
        await pause(350);
        assert.equal((await evaluate(rowsExpression)).find(r => r.aria === 'Staged Changes')?.expanded, 'true', 'manually expanded Staged Changes must remain expanded');
        await capture('manually-expanded-stage-preserved');
        console.log('BETTER_GIT_STAGE_REVEAL_VERIFIED');
    } else if (testReturnApp) {
        // Dummy apps are launched by the test caller, never by production focus code.
        const appA = process.env.BGV_RETURN_APP_A;
        const appB = process.env.BGV_RETURN_APP_B;
        assert.ok(appA && appB, 'Set two running dummy origin app bundle identifiers');
        const jxa = code => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); ${code}`], { encoding: 'utf8' }).trim();
        const front = () => jxa('ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)');
        const focusCode = () => jxa(`$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).activateWithOptions(2);`);
        const focusApp = app => jxa(`$.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(app)}).objectAtIndex(0).activateWithOptions(2);`);
        const uri = (repo, destination) => `vscode://ethansk.better-git-vscode/open-worktree?path=${encodeURIComponent(roots[repo])}${destination === undefined ? '' : '&returnTo=' + encodeURIComponent(destination)}`;
        const appOfCopy = async () => new URL(decodeURIComponent(new URL((await request('copy', { repo: 1 })).value).searchParams.get('url'))).searchParams.get('returnTo');
        async function verifyReturn(repo, destination, expected, name) {
            focusCode();
            await request('uri', { uri: uri(repo, destination) });
            await until(front, app => app === expected, name);
            await check(repo, name);
            assert.equal(front(), expected, `${name}: Source Control inspection must not change native focus`);
            fs.writeFileSync(path.join(evidence, `${name}-focus.json`), JSON.stringify({ expected, observed: front(), worktree: roots[repo] }));
        }
        await request('config', { settings: { worktreeLinkReturnFocus: false, worktreeLinkReturnApp: appA } });
        assert.equal(await appOfCopy(), null, 'disabled copy must omit app metadata');
        await verifyReturn(0, appA, 'com.microsoft.VSCode', 'return-disabled');
        const settings = await request('config', { settings: { worktreeLinkReturnFocus: true, worktreeLinkReturnApp: appA } });
        assert.deepEqual(settings.value, { enabled: true, app: appA });
        assert.equal(await appOfCopy(), appA, 'enabled copy includes configured origin');
        await verifyReturn(1, appA, appA, 'return-explicit-first');
        await verifyReturn(1, appA, appA, 'return-explicit-repeat');
        await verifyReturn(8, appB, appB, 'return-switch-large-other-app');
        await verifyReturn(0, undefined, appA, 'return-legacy-link-fallback');
        await verifyReturn(1, 'com.bettergit.test.not-running', 'com.microsoft.VSCode', 'return-app-not-running');
        await verifyReturn(0, '', 'com.microsoft.VSCode', 'return-invalid-metadata');
        focusCode();
        const opening = request('uri', { uri: uri(1, appA) });
        await pause(250); focusApp(appB);
        await opening;
        assert.equal(front(), appB, 'user switching to another app must win over return');
        await check(1, 'return-user-switched-app');
        focusCode();
        await request('uri', { uri: 'vscode://ethansk.better-git-vscode/open-worktree?path=%2Fdoes-not-exist-bgv&returnTo=' + appA });
        assert.equal(front(), 'com.microsoft.VSCode', 'failed worktree must not return');
        await request('open', { repo: 0 });
        assert.equal(front(), 'com.microsoft.VSCode', 'palette command must not return');
        console.log('PASS return-failed-worktree-and-ordinary-command');
        await request('config', { settings: { worktreeLinkKeepEditorFront: true } });
        const observer = path.join(root, 'app-activation');
        execFileSync('/usr/bin/swiftc', [path.join(extensionRoot, 'scripts/test-app-activation.swift'), '-o', observer]);
        activationMonitor = spawn(observer, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        let activationOutput = '';
        activationMonitor.stdout.on('data', data => { activationOutput += data.toString(); });
        await until(() => activationOutput, value => value.includes('ready\n'), 'native activation observer ready');
        for (const [repo, destination, name] of [[1, appA, 'editor-front-first'], [1, appA, 'editor-front-repeat'],
            [8, appB, 'editor-front-large-other-origin'], [0, undefined, 'editor-front-fallback']]) {
            activationOutput = '';
            // Seed an unrelated previous app so simply staying in Code cannot pass.
            focusApp(destination === appB ? appA : appB);
            await verifyReturn(repo, destination, 'com.microsoft.VSCode', name);
            const expectedOrigin = destination ?? appA;
            const activations = () => activationOutput.trim().split('\n').filter(Boolean);
            await until(activations, events => events.at(-1) === `com.microsoft.VSCode ${child.pid}`
                && events.at(-2)?.startsWith(expectedOrigin + ' '), `${name}: origin then exact editor process`);
            fs.writeFileSync(path.join(evidence, `${name}-app-order.json`), JSON.stringify({
                final: front(), expectedOrigin, activations: activations(),
            }));
        }
        await verifyReturn(1, 'com.bettergit.test.not-running', 'com.microsoft.VSCode', 'editor-front-missing-origin');
        focusCode();
        const openingWithEditorReturn = request('uri', { uri: uri(0, appA) });
        await pause(250); focusApp(appB);
        await openingWithEditorReturn;
        assert.equal(front(), appB, 'user switching to another app must win over the two-step handoff');
        await request('config', { settings: { worktreeLinkReturnFocus: false } });
        await verifyReturn(1, appA, 'com.microsoft.VSCode', 'editor-front-master-disabled');
        console.log('BETTER_GIT_ORIGIN_APP_ORDER_VERIFIED');
        await request('config', { settings: { worktreeLinkReturnFocus: false, worktreeLinkReturnApp: '' } });
    } else {
    // Native keyboard input exercises the mouse protocol's readiness/clear/release
    // command path. Physical mouse hardware itself is outside this harness.
    await key('F20', 'F20', 131, 7);
    await until(() => request('state'), state => state.badge === '💥💥', 'hold readiness badge');
    await pause(150);
    await capture('hold-ready');
    await key('F15', 'F15', 126, 7);
    await until(() => request('state'), state => state.badge === '🔥🔥', 'hold release clears readiness');
    // Repeated native keyDown events model macOS auto-repeat while the physical X key remains down. The
    // contributed Shift+Option+X binding is tagged, so one continuous hold must stage only a.txt. A release
    // followed by a fresh physical press must immediately stage b.txt, while the untagged F18 mouse transport
    // remains independently responsive for c.txt.
    if (testKeyboardRepeat) {
        await repeatedKeyDown('q', 'KeyQ', 81, 9, 25); // Dvorak character on physical X (key code 7).
        await check(1, 'keyboard-held-stage-and-next-once', 'b.txt');
        assert.match(git(roots[1], 'diff', '--cached', '--name-only'), /^a.txt$/m);
        await pause(100);
        await key('q', 'KeyQ', 81, 9);
        await check(1, 'keyboard-fresh-press-after-release', 'c.txt');
        assert.deepEqual(git(roots[1], 'diff', '--cached', '--name-only').trim().split('\n'), ['a.txt', 'b.txt', 'staged-late.txt', 'staged.txt']);
        await key('F18', 'F18', 129);
        await check(1, 'untagged-mouse-stage-after-keyboard', 'd.txt');
    } else {
        await key('F18', 'F18', 129);
        await check(1, 'stage-and-next', 'b.txt');
        assert.match(git(roots[1], 'diff', '--cached', '--name-only'), /^a.txt$/m);
        await key('F18', 'F18', 129); await key('F18', 'F18', 129);
        await check(1, 'rapid-stage-and-next', 'd.txt');
    }
    if (!testKeyboardRepeat) {
        for (const file of ['c.txt', 'b.txt', 'a.txt']) { await key('F16', 'F16', 127); await check(1, `undo-to-${file}`, file); }
        assert.deepEqual(git(roots[1], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged-late.txt', 'staged.txt']);
    }
    // Both source transports: navigation happens before release; release stages only the origin.
    if (!testKeyboardRepeat) for (const [source, modifiers] of [['corsair', 6], ['razer', 12]]) {
        await request('open', { repo: 2 });
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-button-down`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
        await key('F14', 'F14', 125, modifiers); // Short release cancels staging without another navigation.
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-hold-down`, 'c.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '💥💥', 'origin readiness badge');
        await check(2, `${source}-threshold-restores-origin`, 'b.txt');
        assert.equal((await request('state')).badge, '💥💥', 'the original view must be ready while held');
        await capture(`${source}-origin-ready`);
        await key('F16', 'F16', 127); // Agentic Mouse adjacent cell: cancel this hold, not the earlier stage receipt.
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '🔥🔥', 'cancel clears readiness badge');
        await check(2, `${source}-hold-cancel-restores-origin`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
        await key('F18', 'F18', 129, modifiers); // A stale release after cancellation must do nothing.
        await key('F15', 'F15', 126, source === 'corsair' ? 7 : 12);
        await pause(250);
        await check(2, `${source}-cancelled-release-noop`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);

        // Start a fresh hold to retain the established release-stage and ordinary-Undo coverage.
        await key('F13', 'F13', 124, modifiers);
        await check(2, `${source}-post-cancel-hold-down`, 'c.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await until(() => request('badge', { repo: 2, file: 'b.txt' }), state => state.value === '💥💥', 'post-cancel readiness badge');
        await check(2, `${source}-post-cancel-threshold-restores-origin`, 'b.txt');
        await pause(1100);
        await key('F18', 'F18', 129, modifiers);
        await key('F15', 'F15', 126, source === 'corsair' ? 7 : 12);
        await until(() => git(roots[2], 'diff', '--cached', '--name-only'), names => names.includes('b.txt'), 'long release stages original');
        await check(2, `${source}-hold-release`, 'c.txt');
        await key('F16', 'F16', 127);
        await check(2, `${source}-undo-origin`, 'b.txt');
        await key('F17', 'F17', 128, modifiers);
        await check(2, `${source}-previous-down`, 'a.txt');
        await key('F20', 'F20', 131, source === 'corsair' ? 7 : 12);
        await check(2, `${source}-previous-threshold-restores-origin`, 'b.txt');
        await key('F19', 'F19', 130, modifiers);
        await until(() => git(roots[2], 'diff', '--cached', '--name-only'), names => names.includes('b.txt'), 'previous release stages original');
        await key('F16', 'F16', 127);
        await check(2, `${source}-previous-undo`, 'b.txt');
        assert.deepEqual(git(roots[2], 'diff', '--cached', '--name-only').trim().split('\n'), ['staged.txt']);
    }
    if (testKeyboardRepeat) {
        console.log('BETTER_GIT_KEYBOARD_REPEAT_VERIFIED repeated-keydown=one-stage release-and-repress=next-stage untagged-F18=unchanged');
    }
    }
    if (!testNoUnstaged) for (const repo of roots) for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
        assert.equal(fs.readFileSync(path.join(repo, file), 'utf8'), 'modified\n');
    }
    console.log(`BETTER_GIT_NATIVE_WORKTREE_VERIFIED evidence=${evidence}`);
} finally {
    if (fs.existsSync(path.join(root, 'ready.json'))) { await request('stop').catch(() => {}); }
    activationMonitor?.kill('SIGTERM');
    socket?.close();
    child.kill('SIGTERM');
    fs.closeSync(log);
    console.log(`Native test fixture: ${root}`);
}
