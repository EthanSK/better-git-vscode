// Isolated workbench integration, never Ethan's normal VS Code. Run only on Mini.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertE2EHost } from './e2e-host-guard.mjs';
assertE2EHost();
const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync('/tmp/bgv-selection-'));
const executable = process.env.BGV_VSCODE_EXECUTABLE_PATH;
assert.ok(executable && fs.existsSync(executable));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try { last = await read(); if (accept(last)) { return last; } } catch (error) { last = String(error); }
        await pause(75);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
}
fs.writeFileSync(path.join(root, 'selection.txt'), 'AgentFlow selected code\nSecond line for the diff\n');
fs.writeFileSync(path.join(root, 'original.txt'), 'Original code\nSecond line for the diff\n');
const profile = path.join(root, 'profile');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
    'editor.accessibilitySupport': 'off', 'workbench.startupEditor': 'none',
    'editor.minimap.enabled': false, 'diffEditor.renderSideBySide': true
}));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const log = fs.openSync(path.join(root, 'host.log'), 'w');
const child = spawn(executable, [root, `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`,
    `--extensionDevelopmentPath=${extensionRoot}`, `--extensionTestsPath=${path.join(extensionRoot, 'scripts/agentflow-selection-test-driver.cjs')}`,
    `--remote-debugging-port=${port}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry'],
    { env: { ...process.env, BGV_SELECTION_TEST_ROOT: root }, stdio: ['ignore', log, log] });
let websocket;
let send;
let requestID = 0;
async function command(action) {
    const id = ++requestID;
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ id, action }));
    return until(() => JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')), r => r.id === id, action);
}
try {
    const ready = await until(() => JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8')), Boolean, 'host ready', 60_000);
    const targets = await until(async () => (await fetch(`http://127.0.0.1:${port}/json`)).json(), a => a.some(t => t.type === 'page'), 'CDP');
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
    assert.ok(target);
    websocket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve); websocket.addEventListener('error', reject); });
    const pending = new Map(); let sequence = 0;
    websocket.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id) { const pair = pending.get(response.id); pending.delete(response.id);
            if (response.error) { pair?.reject(response.error); } else { pair?.resolve(response.result); } }
    });
    send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject });
        websocket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    await send('Page.bringToFront');
    const directory = `/tmp/agentflow-selection-${process.getuid()}`;
    const endpoint = await until(() => fs.readdirSync(directory).find(n => n.startsWith(`vscode-${ready.pid}-`)), Boolean, 'private socket');
    const socketPath = path.join(directory, endpoint);
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
    const query = (gestureStartedAt, overrides = {}) => new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath);
        let result = '';
        client.setTimeout(1500, () => client.destroy(new Error('bridge timeout')));
        client.on('error', reject);
        client.on('connect', () => client.write(JSON.stringify({ version: 1, nonce: randomUUID(), sourcePID: ready.pid,
            requestedAt: Date.now(), gestureStartedAt, ...overrides }) + '\n'));
        client.on('data', part => { result += part; });
        client.on('end', () => resolve(JSON.parse(result)));
    });
    assert.equal(await query(Date.now()), null, 'No highlight must return null');
    async function highlight(label) {
        const box = await until(() => evaluate(`(()=>{const lines=[...document.querySelectorAll('.monaco-editor .view-line')].filter(e=>e.textContent.replaceAll('\\u00a0',' ').includes('AgentFlow selected code'));const e=lines.at(-1);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`), b => b?.width > 0, label);
        const since = Date.now();
        const y = box.y + box.height / 2;
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 1, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 180, y, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 180, y, button: 'left', clickCount: 1 });
        const captured = await until(() => query(since), r => r?.text?.startsWith('AgentFlow'), label + ' bridge');
        const state = await command('state');
        assert.equal(captured.text, state.text, 'Bridge must match the actual selected range');
        // Exercise the production Swift socket client too, not just a JS stand-in.
        if (process.env.AGENTFLOW_SELECTION_PROBE) {
            const actual = JSON.parse(execFileSync(process.env.AGENTFLOW_SELECTION_PROBE,
                [String(ready.pid), String(since)], { encoding: 'utf8', timeout: 3000 }));
            assert.equal(actual.text, captured.text);
        }
        assert.equal(await query(since, { sourcePID: ready.pid + 1 }), null, 'Wrong process');
        assert.equal(await query(Date.now() + 200), null, 'Later unrelated gesture');
        assert.equal(await query(since, { nonce: 'bad' }), null, 'Malformed request');
        console.log(`PASS ${label}: real mouse selection -> Better Git -> Unix socket -> native client`);
    }
    await highlight('plain editor, screen-reader mode off');
    await command('programmatic');
    await pause(100);
    assert.equal(await query(Date.now() - 500), null, 'Programmatic selection must not become context');
    await command('diff');
    await highlight('diff editor, screen-reader mode off');
    assert.equal(fs.readFileSync(path.join(root, 'selection.txt'), 'utf8'), 'AgentFlow selected code\nSecond line for the diff\n');
    console.log(`AGENTFLOW_SELECTION_E2E_PASSED VSCode=${ready.version} evidence=${root}`);
    await command('stop');
} catch (error) {
    if (send) {
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(root, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
        const dom = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
        fs.writeFileSync(path.join(root, 'failure.txt'), dom.result.value);
    }
    console.error(`Evidence: ${root}`);
    throw error;
} finally {
    websocket?.close();
    child.kill('SIGTERM');
    fs.closeSync(log);
}
