import * as assert from 'assert';
import { runInNewContext } from 'vm';
import { RETURN_TO_CODEX_SCRIPT, returnToCodex } from '../../gitWorktreeFocus';

suite('Git worktree focus', () => {
    test('only returns to one already-running Codex while a handoff app is frontmost', () => {
        for (const front of ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.google.Chrome', 'com.openai.codex', 'com.apple.TextEdit', undefined]) {
            for (const count of [0, 1, 2]) {
                let activations = 0;
                runInNewContext(RETURN_TO_CODEX_SCRIPT, {
                    ObjC: { import: () => {}, unwrap: (value: unknown) => value },
                    $: {
                        NSWorkspace: { sharedWorkspace: { frontmostApplication: front && { bundleIdentifier: front } } },
                        NSRunningApplication: { runningApplicationsWithBundleIdentifier: (id: string) => {
                            assert.strictEqual(id, 'com.openai.codex');
                            return { count: String(count), objectAtIndex: () => ({ activateWithOptions: (options: number) => {
                                assert.strictEqual(options, 2); activations++;
                            } }) };
                        } },
                    },
                });
                assert.strictEqual(activations, count === 1 && front && front !== 'com.apple.TextEdit' ? 1 : 0);
            }
        }
    });
    test('non-macOS links never launch a native process', async () => {
        const run = (async () => { throw new Error('must not execute'); }) as any;
        await returnToCodex('linux', run);
        await returnToCodex('win32', run);
    });
});
