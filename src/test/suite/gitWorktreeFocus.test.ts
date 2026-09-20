import * as assert from 'assert';
import { runInNewContext } from 'vm';
import { RETURN_TO_APP_SCRIPT, returnToApp } from '../../gitWorktreeFocus';

suite('Git worktree focus', () => {
    test('returns only to one running target while a handoff app is frontmost', () => {
        for (const destination of ['com.openai.codex', 'com.apple.TextEdit']) {
            for (const front of ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.google.Chrome', 'com.apple.Safari', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'com.brave.Browser', 'com.openai.codex', destination, 'com.apple.finder', undefined]) {
                for (const count of [0, 1, 2]) {
                    let activations = 0;
                    runInNewContext(RETURN_TO_APP_SCRIPT + '\nrun([destination]);', {
                        destination,
                        ObjC: { import: () => {}, unwrap: (value: unknown) => value },
                        $: {
                            NSWorkspace: { sharedWorkspace: { frontmostApplication: front && { bundleIdentifier: front } } },
                            NSRunningApplication: { runningApplicationsWithBundleIdentifier: (id: string) => {
                                assert.strictEqual(id, destination);
                                return { count: String(count), objectAtIndex: () => ({ activateWithOptions: (options: number) => {
                                    assert.strictEqual(options, 2); activations++;
                                } }) };
                            } },
                        },
                    });
                    assert.strictEqual(activations, count === 1 && front && front !== 'com.apple.finder' ? 1 : 0);
                }
            }
        }
    });
    test('optional editor return waits for the origin and preserves the original editor process', () => {
        for (const mode of ['immediate', 'delayed', 'timeout', 'user-switch', 'activation-failed', 'ambiguous-editor', 'missing-origin', 'browser-start', 'insiders']) {
            const editorId = mode === 'insiders' ? 'com.microsoft.VSCodeInsiders' : 'com.microsoft.VSCode';
            const events: string[] = [];
            let sleeps = 0;
            let current: any;
            const editor = { bundleIdentifier: editorId, processIdentifier: 10, activateWithOptions: () => { events.push('editor'); current = editor; return true; } };
            const origin = { bundleIdentifier: 'com.openai.codex', processIdentifier: 20, activateWithOptions: () => {
                events.push('origin');
                if (['immediate', 'browser-start', 'insiders'].includes(mode)) { current = origin; }
                return mode !== 'activation-failed';
            } };
            current = ['browser-start', 'ambiguous-editor'].includes(mode)
                ? { bundleIdentifier: 'com.google.Chrome', processIdentifier: 30 } : editor;
            runInNewContext(RETURN_TO_APP_SCRIPT + '\nrun([destination, editorId]);', {
                destination: origin.bundleIdentifier, editorId,
                ObjC: { import: () => {}, unwrap: (value: unknown) => value },
                $: {
                    NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return current; } } },
                    NSRunningApplication: { runningApplicationsWithBundleIdentifier: (id: string) => ({
                        count: id === editorId ? (mode === 'ambiguous-editor' ? 2 : 1) : mode === 'missing-origin' ? 0 : 1,
                        objectAtIndex: () => id === editorId ? editor : origin,
                    }) },
                    NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => seconds },
                    NSRunLoop: { currentRunLoop: { runUntilDate: (seconds: number) => {
                        assert.strictEqual(seconds, 0.01); sleeps++;
                        if (mode === 'delayed' && sleeps === 3) { current = origin; }
                        if (mode === 'user-switch') { current = { bundleIdentifier: 'com.google.Chrome', processIdentifier: 99 }; }
                    } } },
                },
            });
            assert.deepStrictEqual(events, ['ambiguous-editor', 'missing-origin'].includes(mode) ? []
                : ['timeout', 'user-switch', 'activation-failed'].includes(mode) ? ['origin'] : ['origin', 'editor'], mode);
            if (mode === 'delayed') { assert.strictEqual(sleeps, 3); }
            if (mode === 'timeout') { assert.strictEqual(sleeps, 50); }
            if (mode === 'user-switch') { assert.strictEqual(sleeps, 1); }
        }
    });
    test('passes only supported editor identifiers and defaults to the existing one-way return', async () => {
        for (const editor of [undefined, 'com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.apple.TextEdit', '-e.bad']) {
            const run = (async (_file: string, args: string[]) => {
                assert.deepStrictEqual(args.slice(4), ['com.openai.codex',
                    ...(['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'].includes(editor ?? '') ? [editor] : [])]);
            }) as any;
            await returnToApp('com.openai.codex', 'darwin', run, editor);
        }
    });
    test('passes a validated app as process data, never script source', async () => {
        let calls = 0;
        const run = (async (file: string, args: string[], options: unknown) => {
            calls++;
            assert.strictEqual(file, '/usr/bin/osascript');
            assert.deepStrictEqual(args, ['-l', 'JavaScript', '-e', RETURN_TO_APP_SCRIPT, 'com.apple.TextEdit']);
            assert.deepStrictEqual(options, { timeout: 5000 });
        }) as any;
        await returnToApp('com.apple.TextEdit', 'darwin', run);
        assert.strictEqual(calls, 1);
    });
    test('unsupported systems and invalid apps never launch a native process', async () => {
        const run = (async () => { throw new Error('must not execute'); }) as any;
        await returnToApp('com.openai.codex', 'linux', run);
        await returnToApp('com.openai.codex', 'win32', run);
        for (const value of ['', '-e.any', 'com..app', '/Applications/TextEdit.app', 'com.apple.TextEdit;bad', 'com.x\n', 'x'.repeat(256)]) {
            await returnToApp(value, 'darwin', run);
        }
    });
});
