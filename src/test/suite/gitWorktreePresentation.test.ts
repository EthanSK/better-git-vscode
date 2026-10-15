import * as assert from 'assert';
import { DeferredWorktreePresentation, WORKTREE_PRESENTATION_MAX_AGE_MS } from '../../gitWorktreePresentation';

suite('Deferred Worktree presentation', () => {
    function fixture() {
        let focused = false;
        let now = 0;
        const listeners = new Set<() => void>();
        const scheduler = new DeferredWorktreePresentation(listener => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        }, () => focused, () => now);
        return { scheduler, listeners, advance(ms = WORKTREE_PRESENTATION_MAX_AGE_MS) { now += ms; }, focus(value = true) {
            focused = value;
            for (const listener of [...listeners]) { listener(); }
        } };
    }
    test('an old background link never presents on later app returns', () => {
        const f = fixture();
        let count = 0;
        f.scheduler.schedule(() => true, () => { count++; });
        f.advance();
        f.focus(); f.focus(false); f.focus();
        assert.strictEqual(count, 0);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('the normal handoff still presents just before expiry', () => {
        const f = fixture();
        let count = 0;
        f.scheduler.schedule(() => true, () => { count++; });
        f.advance(WORKTREE_PRESENTATION_MAX_AGE_MS - 1);
        f.focus();
        assert.strictEqual(count, 1);
    });
    test('loading time counts toward the original link deadline', () => {
        const f = fixture();
        let count = 0;
        f.advance(); f.focus();
        f.scheduler.schedule(() => true, () => { count++; }, WORKTREE_PRESENTATION_MAX_AGE_MS);
        assert.strictEqual(count, 0);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('expiry invalidates an admitted queued presentation', async () => {
        const f = fixture();
        let current!: () => boolean;
        let finish!: (complete: boolean) => void;
        f.scheduler.schedule(() => true, isScheduled => {
            current = isScheduled;
            return new Promise<boolean>(resolve => { finish = resolve; });
        });
        f.focus();
        assert.strictEqual(current(), true);
        f.advance();
        assert.strictEqual(current(), false);
        finish(false);
        await Promise.resolve();
        assert.strictEqual(f.listeners.size, 0);
    });
    test('an interrupted pass cannot retry after its original deadline', async () => {
        const f = fixture();
        let count = 0;
        f.scheduler.schedule(() => true, async () => { count++; return false; });
        f.focus(); f.focus(false);
        await Promise.resolve();
        f.advance(); f.focus();
        assert.strictEqual(count, 1);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('an expired old completion cannot remove a fresh link listener', async () => {
        const f = fixture();
        let finish!: (complete: boolean) => void;
        f.scheduler.schedule(() => true, () => new Promise<boolean>(resolve => { finish = resolve; }));
        f.focus(); f.focus(false); f.advance();
        let count = 0;
        f.scheduler.schedule(() => true, () => { count++; });
        finish(false);
        await Promise.resolve();
        assert.strictEqual(f.listeners.size, 1);
        f.focus();
        assert.strictEqual(count, 1);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('background work does not wait and native presentation runs once on focus', () => {
        const f = fixture();
        let count = 0;
        f.scheduler.schedule(() => true, () => { count++; });
        f.focus(false);
        assert.strictEqual(count, 0);
        f.focus(); f.focus();
        assert.strictEqual(count, 1);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('a newer link replaces the pending presentation', () => {
        const f = fixture();
        const completed: string[] = [];
        f.scheduler.schedule(() => true, () => { completed.push('old'); });
        f.scheduler.schedule(() => true, () => { completed.push('new'); });
        assert.strictEqual(f.listeners.size, 1);
        f.focus();
        assert.deepStrictEqual(completed, ['new']);
    });
    test('user navigation cancels the pending presentation without retrying later', () => {
        const f = fixture();
        let owned = true;
        let count = 0;
        f.scheduler.schedule(() => owned, () => { count++; });
        owned = false;
        f.focus();
        owned = true;
        f.focus();
        assert.strictEqual(count, 0);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('activation between the caller check and subscription is handled immediately', () => {
        const f = fixture();
        f.focus();
        let count = 0;
        f.scheduler.schedule(() => true, () => { count++; });
        assert.strictEqual(count, 1);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('extension shutdown removes the listener', () => {
        const f = fixture();
        let count = 0;
        f.scheduler.schedule(() => true, () => { count++; });
        f.scheduler.dispose(); f.focus();
        assert.strictEqual(count, 0);
        assert.strictEqual(f.listeners.size, 0);
    });
    test('review interaction cancels a retry already admitted to the link queue', () => {
        const f = fixture();
        let queued!: () => boolean;
        f.scheduler.schedule(() => true, isScheduled => { queued = isScheduled; });
        f.focus();
        assert.strictEqual(queued(), true);
        f.scheduler.dispose();
        assert.strictEqual(queued(), false);
    });
    test('a new link cancels an already admitted older retry', () => {
        const f = fixture();
        let older!: () => boolean;
        f.scheduler.schedule(() => true, isScheduled => { older = isScheduled; });
        f.focus();
        f.focus(false);
        f.scheduler.schedule(() => true, () => undefined);
        assert.strictEqual(older(), false);
    });
    test('focus lost during a running presentation keeps it pending for the next focus', async () => {
        const f = fixture();
        let count = 0;
        let finish!: (complete: boolean) => void;
        f.scheduler.schedule(() => true, () => {
            count++;
            return new Promise<boolean>(resolve => { finish = resolve; });
        });
        f.focus();
        f.focus(false);
        finish(false);
        await Promise.resolve();
        assert.strictEqual(f.listeners.size, 1);
        assert.strictEqual(count, 1);
        f.focus();
        assert.strictEqual(count, 2);
        finish(true);
        await Promise.resolve();
        assert.strictEqual(f.listeners.size, 0);
    });
    test('focus regained while queued retries once after the pending pass', async () => {
        const f = fixture();
        let count = 0;
        let finish!: (complete: boolean) => void;
        f.scheduler.schedule(() => true, () => {
            count++;
            return new Promise<boolean>(resolve => { finish = resolve; });
        });
        f.focus(); f.focus(false); f.focus(); f.focus();
        assert.strictEqual(count, 1, 'never overlap passes');
        finish(false);
        await Promise.resolve();
        assert.strictEqual(count, 2);
        finish(false);
        await Promise.resolve();
        assert.strictEqual(count, 2, 'never retry without a new focus event');
        f.scheduler.dispose();
    });
    test('cancelled asynchronous completion cannot clear the replacement listener', async () => {
        const f = fixture();
        let finish!: (complete: boolean) => void;
        f.scheduler.schedule(() => true, () => new Promise<boolean>(resolve => { finish = resolve; }));
        f.focus(); f.focus(false);
        let next = 0;
        f.scheduler.schedule(() => true, () => { next++; });
        finish(true);
        await Promise.resolve();
        assert.strictEqual(f.listeners.size, 1);
        f.focus();
        assert.strictEqual(next, 1);
    });
    test('navigation during an interrupted pass abandons its retry', async () => {
        const f = fixture();
        let owned = true;
        let count = 0;
        let finish!: (complete: boolean) => void;
        f.scheduler.schedule(() => owned, () => {
            count++;
            return new Promise<boolean>(resolve => { finish = resolve; });
        });
        f.focus(); f.focus(false);
        owned = false;
        finish(false);
        await Promise.resolve();
        f.focus();
        assert.strictEqual(count, 1);
        assert.strictEqual(f.listeners.size, 0);
    });
});
