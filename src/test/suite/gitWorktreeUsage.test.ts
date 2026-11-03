// Deterministic first-action evidence: scripted handoff, wrong roots and focus races never become reviews.
import * as assert from 'assert';
import { WorktreeUsage, WorktreeUsageEvent } from '../../gitWorktreeUsage';

suite('Worktree click usage', () => {
    function fixture() {
        let focused = true, now = 0;
        const events: WorktreeUsageEvent[] = [];
        let resolve: (app: string | undefined) => void = () => undefined;
        const usage = new WorktreeUsage('/tmp/review', event => events.push(event),
            () => new Promise(done => { resolve = done; }), () => focused, () => now);
        return { usage, events, focus(value: boolean) { focused = value; usage.focusChanged(value); },
            async app(bundle: string | undefined) { resolve(bundle); await Promise.resolve(); },
            advance() { now += 100; }, outcome() { return events.find(event => event.event === 'outcome'); } };
    }
    test('automatic handoff and automatic editor opening do not classify a click', () => {
        const f = fixture();
        try {
            f.focus(false); f.focus(true);
            f.usage.reviewInput('cursor-move', '/tmp/review/a.ts');
            assert.strictEqual(f.outcome(), undefined);
            f.usage.arm();
            assert.deepStrictEqual(f.events.map(event => event.event), ['click', 'observing']);
        } finally { f.usage.dispose(); }
    });
    test('target review input wins once and records its elapsed time', () => {
        const f = fixture();
        try {
            f.usage.arm(); f.advance();
            f.usage.reviewInput('review-navigation', '/tmp/review/a.ts');
            f.usage.reviewInput('document-edit', '/tmp/review/b.ts');
            assert.strictEqual(f.outcome()?.outcome, 'review-input-first');
            assert.strictEqual(f.outcome()?.elapsedMs, 100);
            assert.strictEqual(f.events.filter(event => event.event === 'outcome').length, 1);
            assert.ok(f.events.every(event => event.id === f.events[0].id));
            assert.ok(!JSON.stringify(f.events).includes('/tmp'));
        } finally { f.usage.dispose(); }
    });
    test('a different root, prefix sibling or missing file is not review evidence', () => {
        const f = fixture();
        try {
            f.usage.arm();
            for (const file of ['/tmp/other/a.ts', '/tmp/review-other/a.ts', undefined]) {
                f.usage.reviewInput('review-navigation', file);
            }
            assert.strictEqual(f.outcome(), undefined);
        } finally { f.usage.dispose(); }
    });
    test('Codex returning before review input is identified by its actual app identity', async () => {
        const f = fixture();
        try {
            f.usage.arm(); f.focus(false); await f.app('com.openai.codex');
            assert.strictEqual(f.outcome()?.outcome, 'codex-return-first');
        } finally { f.usage.dispose(); }
    });
    test('Chrome or an unavailable app stays unknown', async () => {
        for (const app of ['com.google.Chrome', undefined]) {
            const f = fixture();
            try {
                f.usage.arm(); f.focus(false); await f.app(app);
                assert.strictEqual(f.outcome()?.outcome, 'unknown');
            } finally { f.usage.dispose(); }
        }
    });
    test('configured automatic Codex return is separate from the user choosing to return', () => {
        const f = fixture();
        f.usage.automaticReturnConfigured(); f.usage.arm(); f.usage.dispose();
        assert.strictEqual(f.outcome()?.outcome, 'automatic-return-configured');
        assert.strictEqual(f.events.length, 2);
    });
    test('a delayed focus sample cannot turn a later review into the first action', async () => {
        const f = fixture();
        try {
            f.usage.arm(); f.focus(false); f.focus(true);
            f.usage.reviewInput('cursor-move', '/tmp/review/a.ts');
            await f.app('com.openai.codex');
            assert.strictEqual(f.outcome()?.outcome, 'unknown');
            assert.strictEqual(f.outcome()?.reason, 'focus-sample-raced-review');
        } finally { f.usage.dispose(); }
    });
    test('already unfocused after handoff is sampled and a superseded click ignores late results', async () => {
        const f = fixture();
        f.focus(false); f.usage.arm(); f.usage.finish('newer-link');
        await f.app('com.openai.codex');
        assert.strictEqual(f.outcome()?.outcome, 'unknown');
        assert.strictEqual(f.outcome()?.reason, 'newer-link');
        assert.strictEqual(f.events.filter(event => event.event === 'outcome').length, 1);
    });
    test('failure to write diagnostics never blocks review input', () => {
        const usage = new WorktreeUsage('/tmp/review', () => { throw new Error('logging unavailable'); },
            async () => undefined, () => true);
        assert.doesNotThrow(() => { usage.arm(); usage.reviewInput('document-edit', '/tmp/review/a.ts'); usage.dispose(); });
    });
});
