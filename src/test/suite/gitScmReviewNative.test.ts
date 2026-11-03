// Exercise the native IPC boundary: stale presentation must never apply after a newer preview or release.
import * as assert from 'assert';
import { EventEmitter } from 'events';
import { MacScmReviewLookahead } from '../../macScmReviewLookahead';
import { MonitorProcess } from '../../macKeyReleaseMonitor';

class Worker extends EventEmitter implements MonitorProcess {
    messages: Array<Record<string, unknown>> = [];
    kills = 0;
    stdout = new EventEmitter();
    stdin = Object.assign(new EventEmitter(), { write: (line: string) => { const message = JSON.parse(line); this.messages.push(message); if (message.action === 'reset') { queueMicrotask(() => this.reply({ id: message.id, ok: true })); } } });
    reply(value: object): void { this.stdout.emit('data', JSON.stringify(value) + '\n'); }
    kill(): void { this.kills++; this.emit('exit'); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const geometry = (id: number) => ({ id, ok: true, top: 100, bottom: 500, rowTop: 400, rowHeight: 20 });
suite('SCM native lookahead boundary', () => {
    test('only the latest preview can apply a measured scroll', async () => {
        const worker = new Worker();
        const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform: 'darwin', spawn: () => worker });
        const target = (path: string) => ({ path, remainingFiles: 20, sensitivity: 1, current: () => true });
        presenter.request(target('/first')); presenter.request(target('/latest'));
        assert.equal(worker.messages.length, 1);
        worker.reply(geometry(1)); await tick();
        assert.equal(worker.messages.length, 2);
        assert.equal(worker.messages[1].action, 'measure'); assert.equal(worker.messages[1].path, '/latest');
        worker.reply(geometry(2)); await tick();
        assert.equal(worker.messages[2].action, 'apply'); assert.equal(worker.messages[2].id, 2);
        worker.reply({ id: 2, ok: true }); await tick(); presenter.dispose();
    });
    test('release resets native presentation immediately and cannot apply its late reply', async () => {
        const worker = new Worker();
        const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform: 'darwin', spawn: () => worker });
        presenter.request({ path: '/a', remainingFiles: 20, sensitivity: 1, current: () => true });
        presenter.cancel(); worker.reply(geometry(1)); await tick();
        assert.equal(worker.messages[1].action, 'reset'); assert.equal(worker.messages.filter(message => message.action === 'apply').length, 0); presenter.dispose();
    });
    test('missing geometry and a short remaining list do not scroll', async () => {
        const worker = new Worker();
        const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform: 'darwin', spawn: () => worker });
        presenter.request({ path: '/a', remainingFiles: 1, sensitivity: 1, current: () => true });
        worker.reply(geometry(1)); await tick(); assert.equal(worker.messages.length, 1);
        presenter.request({ path: '/b', remainingFiles: 20, sensitivity: 1, current: () => true });
        worker.reply({ id: 2, ok: true }); await tick(); assert.equal(worker.messages.length, 2); presenter.dispose();
    });
    test('disposing a waiting worker closes its input so native cleanup can run', async () => {
        const worker = new Worker(), ended: string[] = [];
        Object.assign(worker.stdin, { end: (line: string) => { ended.push(line); } });
        const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform: 'darwin', spawn: () => worker });
        presenter.request({ path: '/a', remainingFiles: 20, sensitivity: 1, current: () => true });
        presenter.dispose(); await tick();
        assert.equal(ended.length, 1); assert.equal(JSON.parse(ended[0]).action, 'reset');
        assert.equal(worker.kills, 0, 'do not bypass native restoration with an immediate signal');
        worker.emit('exit');
    });
    test('ordinary navigation restores borrowed accessibility without needing a hold release', async () => {
        const worker = new Worker();
        const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform: 'darwin', spawn: () => worker });
        presenter.request({ path: '/normal', remainingFiles: 20, sensitivity: 1, current: () => true, restoreAfter: true });
        worker.reply(geometry(1)); await tick();
        assert.equal(worker.messages[1].action, 'apply');
        worker.reply({ id: 1, ok: true }); await tick();
        assert.equal(worker.messages[2].action, 'reset');
        presenter.dispose();
    });
    test('superseded ordinary presentation restores accessibility before a stale queued target is skipped', async () => {
        const worker = new Worker();
        const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform: 'darwin', spawn: () => worker });
        presenter.request({ path: '/normal', remainingFiles: 20, sensitivity: 1, current: () => true, restoreAfter: true });
        presenter.request({ path: '/left', remainingFiles: 20, sensitivity: 1, current: () => false, restoreAfter: true });
        worker.reply(geometry(1)); await tick();
        assert.deepEqual(worker.messages.map(message => message.action), ['measure', 'reset']);
        presenter.dispose();
    });
    test('non-macOS and stale held requests never start a native worker', async () => {
        let starts = 0;
        for (const [platform, current] of [['linux', true], ['darwin', false]] as const) {
            const presenter = new MacScmReviewLookahead('/worker', 123, () => {}, { platform, spawn: () => { starts++; return new Worker(); } });
            presenter.request({ path: '/a', remainingFiles: 20, sensitivity: 1, current: () => current }); await tick(); presenter.dispose();
        }
        assert.equal(starts, 0);
    });
});
