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
