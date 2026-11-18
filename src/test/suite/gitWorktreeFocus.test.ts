// Non-GUI AppKit handoff state checks; the Mini native suite verifies the real workbench sequence.
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
    test('optional handoff confirms the origin without raising a process-wide Code window', () => {
        for (const mode of ['immediate', 'delayed', 'timeout', 'user-switch', 'activation-failed',
            'ambiguous-editor', 'missing-origin', 'browser-start', 'insiders', 'explicit-editor', 'stale-editor-pid']) {
            const editorId = mode === 'insiders' ? 'com.microsoft.VSCodeInsiders' : 'com.microsoft.VSCode';
            const editor = { bundleIdentifier: editorId, processIdentifier: 10,
                activateWithOptions: () => assert.fail('Only the owning VS Code workbench can raise its window') };
            const browser = { bundleIdentifier: 'com.google.Chrome', processIdentifier: 30 };
            let current: { bundleIdentifier: string; processIdentifier: number } =
                ['browser-start', 'ambiguous-editor', 'explicit-editor', 'stale-editor-pid'].includes(mode) ? browser : editor;
            let activations = 0;
            let samples = 0;
            const immediate = ['immediate', 'browser-start', 'insiders', 'explicit-editor'].includes(mode);
            const origin = { bundleIdentifier: 'com.openai.codex', processIdentifier: 20, activateWithOptions: () => {
                activations++;
                if (immediate) { current = origin; }
                return mode !== 'activation-failed';
            } };
            const result = runInNewContext(RETURN_TO_APP_SCRIPT + '\nrun([destination, editorId, editorPid, undefined, "window"]);', {
                destination: origin.bundleIdentifier, editorId,
                editorPid: ['explicit-editor', 'stale-editor-pid'].includes(mode) ? '10' : undefined,
                ObjC: { import: () => {}, unwrap: (value: unknown) => value },
                $: {
                    NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return current; } } },
                    NSRunningApplication: { runningApplicationsWithBundleIdentifier: (id: string) => ({
                        count: id === editorId ? (['ambiguous-editor', 'explicit-editor', 'stale-editor-pid'].includes(mode) ? 2 : 1)
                            : mode === 'missing-origin' ? 0 : 1,
                        objectAtIndex: () => id === editorId ? editor : origin,
                    }), runningApplicationWithProcessIdentifier: () =>
                        mode === 'stale-editor-pid' ? { bundleIdentifier: 'com.apple.finder', processIdentifier: 10 } : editor },
                    NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => seconds },
                    NSRunLoop: { currentRunLoop: { runUntilDate: (seconds: number) => {
                        assert.strictEqual(seconds, 0.01);
                        samples++;
                        if (mode === 'delayed' && samples === 3) { current = origin; }
                        if (mode === 'user-switch') { current = { ...browser, processIdentifier: 99 }; }
                    } } },
                },
            });
            assert.strictEqual(activations, ['ambiguous-editor', 'missing-origin', 'stale-editor-pid'].includes(mode) ? 0 : 1, mode);
            assert.strictEqual(result, immediate || mode === 'delayed' ? 'origin-active' : undefined, mode);
            if (mode === 'delayed') { assert.strictEqual(samples, 3); }
            if (mode === 'timeout') { assert.strictEqual(samples, 50); }
            if (mode === 'user-switch') { assert.strictEqual(samples, 1); }
        }
    });
    test('legacy Code returns to the editor application without requiring a window command', () => {
        const events: string[] = [];
        let current: { bundleIdentifier: string; processIdentifier: number };
        const editor = { bundleIdentifier: 'com.microsoft.VSCode', processIdentifier: 10,
            activateWithOptions: () => { events.push('Code'); current = editor; return true; } };
        const origin = { bundleIdentifier: 'com.openai.codex', processIdentifier: 20,
            activateWithOptions: () => { events.push('origin'); current = origin; return true; } };
        current = editor;
        const result = runInNewContext(RETURN_TO_APP_SCRIPT + '\nrun(["com.openai.codex", "com.microsoft.VSCode"]);', {
            ObjC: { import: () => {}, unwrap: (value: unknown) => value },
            $: { NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return current; } } },
                NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => origin }) } },
        });
        assert.strictEqual(result, 'editor-active');
        assert.deepStrictEqual(events, ['origin', 'Code']);
    });
    test('an origin restore refuses a newer frontmost process inside the native call', () => {
        for (const pid of [10,11]) {
            let calls=0;
            runInNewContext(RETURN_TO_APP_SCRIPT+'\nrun(["com.openai.codex", "", "", "10"]);',{
                ObjC:{import:()=>{},unwrap:(value:unknown)=>value},
                $:{NSWorkspace:{sharedWorkspace:{frontmostApplication:{bundleIdentifier:'com.microsoft.VSCode',processIdentifier:pid}}},
                    NSRunningApplication:{runningApplicationsWithBundleIdentifier:()=>({count:1,objectAtIndex:()=>({activateWithOptions:()=>{calls++;return true;}})})}},
            });
            assert.strictEqual(calls,pid===10 ? 1 : 0);
        }
    });
    test('passes exact editor identity and the final frontmost-process guard as data', async () => {
        const acknowledged=(async(_file:string,args:string[])=>{
            assert.deepStrictEqual(args.slice(4),['com.openai.codex','com.microsoft.VSCode','123','','window']);
            return {stdout:'origin-active\n'};
        }) as any;
        assert.strictEqual(await returnToApp('com.openai.codex','darwin',acknowledged,'com.microsoft.VSCode',123,undefined,true),'origin-active');
        const restore=(async(_file:string,args:string[])=>{
            assert.deepStrictEqual(args.slice(4),['com.openai.codex','','','123']); return {stdout:''};
        }) as any;
        assert.strictEqual(await returnToApp('com.openai.codex','darwin',restore,undefined,undefined,123),undefined);
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
