import * as assert from 'assert';
import { ScmReviewLookahead, scmReviewScrollDistance, ScmReviewViewport } from '../../scmReviewLookahead';

suite('Source Control review lookahead', () => {
    const view = (changes: Partial<ScmReviewViewport> = {}): ScmReviewViewport => ({
        top: 100, bottom: 700, rowTop: 500, rowHeight: 20, remainingFiles: 50, lookahead: 10, ...changes,
    });

    test('a file near the bottom keeps ten file rows of context above it', () => {
        assert.strictEqual(scmReviewScrollDistance(view()), 200);
    });
    test('ten complete following rows already visible need no movement', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 480 })), 0);
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 300 })), 0);
    });
    test('the end of the worktree does not repeatedly scroll when every remaining file fits', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 600, remainingFiles: 4 })), 0);
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 600, remainingFiles: 5 })), 300);
        assert.strictEqual(scmReviewScrollDistance(view({ remainingFiles: 0 })), 0);
    });
    test('short panes request only the following rows they can fit', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ bottom: 200, rowTop: 100 })), 0);
        assert.strictEqual(scmReviewScrollDistance(view({ bottom: 200, rowTop: 140 })), 40);
        assert.strictEqual(scmReviewScrollDistance(view({ bottom: 120, rowTop: 100 })), 0);
    });
    test('fractional row positions do not count clipped rows as fully visible', () => {
        assert.strictEqual(scmReviewScrollDistance(view({ rowTop: 480.25 })), 180.25);
    });
    test('a medium pane preserves the context that fits alongside ten following rows', () => {
        const distance = scmReviewScrollDistance(view({ bottom: 500, rowTop: 460 }));
        assert.strictEqual(distance, 180);
        assert.strictEqual((460 - distance - 100) / 20, 9);
        assert.strictEqual((500 - (460 - distance) - 20) / 20, 10);
    });
    test('the jump satisfies lookahead and does not retrigger at the same row', () => {
        for (const capacity of [2, 5, 15, 20, 21, 30]) {
            const before = view({ bottom: 100 + capacity * 20, rowTop: 100 + (capacity - 1) * 20 });
            const distance = scmReviewScrollDistance(before);
            const after = { ...before, rowTop: before.rowTop - distance };
            const below = Math.floor((after.bottom - after.rowTop - after.rowHeight) / after.rowHeight);
            assert.ok(below >= Math.min(10, capacity - 1));
            assert.strictEqual(scmReviewScrollDistance(after), 0);
        }
    });
    test('missing, off-screen or malformed geometry never moves the list', () => {
        for (const changes of [{ rowTop: 99 }, { rowTop: 690 }, { rowHeight: 0 }, { bottom: 100 },
            { top: NaN }, { rowTop: Infinity }, { remainingFiles: -1 }, { lookahead: 0 }]) {
            assert.strictEqual(scmReviewScrollDistance(view(changes)), 0);
        }
    });
    test('native planning uses the same standalone function', () => {
        const native = new Function(`return (${scmReviewScrollDistance.toString()})`)() as typeof scmReviewScrollDistance;
        assert.strictEqual(native(view()), 200);
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
