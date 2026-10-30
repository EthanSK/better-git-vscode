import * as assert from 'assert';
import { ScmReviewLookahead, scmReviewScrollDistance, ScmReviewViewport } from '../../scmReviewLookahead';

suite('Source Control review lookahead', () => {
    const view = (changes: Partial<ScmReviewViewport> = {}): ScmReviewViewport => ({
        top: 100, bottom: 700, rowTop: 500, rowHeight: 20, remainingFiles: 50, lookahead: 10, ...changes,
    });

    test('a file near the bottom moves to the top of the visible file area', () => {
        assert.strictEqual(scmReviewScrollDistance(view()), 400);
    });
    test('ten complete following rows already visible need no movement', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 480 })), 0);
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 300 })), 0);
    });
    test('the end of the worktree does not repeatedly scroll when every remaining file fits', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 600, remainingFiles: 4 })), 0);
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 600, remainingFiles: 5 })), 500);
        assert.strictEqual(scmReviewScrollDistance(view({ remainingFiles: 0 })), 0);
    });
    test('short panes request only the following rows they can fit', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ bottom: 200, rowTop: 100 })), 0);
        assert.strictEqual(scmReviewScrollDistance(view({ bottom: 200, rowTop: 140 })), 40);
        assert.strictEqual(scmReviewScrollDistance(view({ bottom: 120, rowTop: 100 })), 0);
    });
    test('fractional row positions do not count clipped rows as fully visible', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 480.25 })), 380.25);
    });
    test('missing, off-screen or malformed geometry never moves the list', () => {
        for (const changes of [{ rowTop: 99 }, { rowTop: 690 }, { rowHeight: 0 }, { bottom: 100 },
            { top: NaN }, { rowTop: Infinity }, { remainingFiles: -1 }, { lookahead: 0 }]) {
            assert.strictEqual(scmReviewScrollDistance(view(changes)), 0);
        }
    });
    test('native planning uses the same standalone function', () => {
        const native = new Function(`return (${scmReviewScrollDistance.toString()})`)() as typeof scmReviewScrollDistance;
        assert.strictEqual(native(view()), 400);
        assert.strictEqual(native(view({ remainingFiles: 2 })), 0);
    });

    const tick = () => new Promise(resolve => setImmediate(resolve));
    test('rapid file changes leave only the latest pending presentation, without waiting at request time', async () => {
        let finish!: () => void;
        const calls: number[] = [];
        const live: Array<() => boolean> = [];
        const queue = new ScmReviewLookahead<number>(async (file, current) => {
            calls.push(file); live.push(current);
            if (file === 1) { await new Promise<void>(resolve => { finish = resolve; }); }
        }, () => undefined, () => assert.fail('unexpected native error'));
        queue.request(1); queue.request(2); queue.request(3);
        assert.deepStrictEqual(calls, [1]);
        assert.strictEqual(live[0](), false, 'an old native request must detect that its target changed');
        finish(); await tick();
        assert.deepStrictEqual(calls, [1, 3]);
        assert.strictEqual(live[1](), true);
        queue.dispose();
    });
    test('release or cancellation retires pending presentation immediately', async () => {
        let finish!: () => void;
        let current!: () => boolean;
        let stopped = 0;
        const calls: number[] = [];
        const queue = new ScmReviewLookahead<number>(async (file, valid) => {
            calls.push(file); current = valid;
            await new Promise<void>(resolve => { finish = resolve; });
        }, () => { stopped++; }, () => undefined);
        queue.request(1); queue.request(2); queue.cancel();
        assert.strictEqual(current(), false);
        assert.strictEqual(stopped, 1);
        finish(); await tick();
        assert.deepStrictEqual(calls, [1]);
        queue.dispose(); queue.request(3); await tick();
        assert.deepStrictEqual(calls, [1]);
    });
    test('a native failure cannot discard a later presentation or reject navigation', async () => {
        const calls: number[] = [];
        let failures = 0;
        const queue = new ScmReviewLookahead<number>(async file => {
            calls.push(file);
            if (file === 1) { throw new Error('native access unavailable'); }
        }, () => undefined, () => { failures++; });
        queue.request(1); queue.request(2); await tick();
        assert.deepStrictEqual(calls, [1, 2]);
        assert.strictEqual(failures, 1);
        queue.dispose();
    });
});
