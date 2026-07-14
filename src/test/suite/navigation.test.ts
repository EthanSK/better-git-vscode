import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// E2E suite for next/previous-scm-change navigation (v1.2.1).
//
// WHY THIS EXISTS: v1.2.0 shipped a "scroll through newly-added files" feature that regressed
// navigation hard — the 5-line step wrongly fired on MODIFIED files (hijacking hunk navigation)
// and stepped stale hidden editors (perceived total no-op). These tests run against a REAL git
// repo fixture (created by runTest.ts before the host launched) and pin down the intended
// behaviour for every git file-state so the regression can't come back:
//   • MODIFIED file          -> hunk-to-hunk navigation, NEVER the 5-line step  (THE regression)
//   • untracked new file     -> ±5-line stepping in the plain editor; file fall-through at edges
//   • staged-new (INDEX_ADDED) plain editor -> steps; as empty-original DIFF -> normal nav (advances)
//   • DELETED (unstaged + INDEX_DELETED)    -> never steps, advances to the next file
//   • RENAMED (INDEX_RENAMED)               -> never steps, advances normally
//   • short/empty new files, custom newFileNavLineJump
//
// All git state changes go through real `git` subprocesses + the vscode.git API's status(), with
// polling helpers (no fixed sleeps on the happy path) so the suite is deterministic-but-fast.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ── generic polling helper: resolve as soon as fn() returns a truthy value, else fail loudly ──
const poll = async <T>(fn: () => T | undefined | null | false, what: string, timeoutMs = 15000, intervalMs = 100): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	// keep the last error so a throwing probe still surfaces useful info on timeout
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const v = fn();
			if (v) {
				return v;
			}
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`Timed out waiting for: ${what}${lastErr ? ` (last error: ${lastErr})` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The git "empty tree" id — used to build the empty side of a staged-new / staged-deleted diff exactly
// like the extension's openChangeEntry does. Computed from the fixture repo in suiteSetup (NOT hardcoded
// to the SHA-1 constant) so the suite also works if the repo was initialised with the SHA-256 object
// format (Codex review finding).
let EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // SHA-1 default, overwritten in suiteSetup

// Replicates the extension's toGitUri so tests can open the exact staged diffs openChangeEntry builds.
const toGitUri = (uri: vscode.Uri, ref: string): vscode.Uri =>
	uri.with({ scheme: 'git', path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });

// Resolve any uri (file: or git:) back to its on-disk path — git: uris carry the real path in the query.
const uriFilePath = (u: vscode.Uri): string => {
	if (u.scheme === 'git') {
		try {
			const q = JSON.parse(u.query);
			if (q?.path) {
				return vscode.Uri.file(q.path).path;
			}
		} catch {
			// fall through to u.path
		}
	}
	return u.path;
};

// On-disk path of whatever the active tab is showing (diff -> its modified/right side).
const activeTabPath = (): string | undefined => {
	const input: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputTextDiff) {
		return uriFilePath(input.modified);
	}
	if (input instanceof vscode.TabInputText) {
		return uriFilePath(input.uri);
	}
	return undefined;
};

// The visible TextEditor rendering `fileUri`'s document (matches by exact uri string).
const visibleEditorFor = (fileUri: vscode.Uri): vscode.TextEditor | undefined =>
	vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === fileUri.toString());

suite('SCM change navigation E2E', () => {
	let ws: string; // fixture workspace root (a real git repo, see runTest.ts)
	let repo: any; // vscode.git API Repository for the fixture
	let baseSha: string; // the base commit every test resets to

	// Run a git command inside the fixture. All command strings are hardcoded test constants.
	const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: ws, stdio: 'pipe' }).toString().trim();

	// Write a file (creating parent dirs) relative to the workspace root.
	const write = (rel: string, content: string) => {
		const abs = path.join(ws, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
		return vscode.Uri.file(abs);
	};

	const wsUri = (rel: string) => vscode.Uri.file(path.join(ws, rel));

	// n lines joined WITHOUT a trailing newline, so document.lineCount === n exactly — keeps the
	// step-target arithmetic in assertions deterministic (a trailing \n adds a phantom empty last line).
	const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n');
	const wrappedTypeScriptFixture = () => {
		const result = ['export class WrappedNavigationFixture {'];
		for (let i = 0; i < 70; i++) {
			result.push(`  method${i + 1}(): string {`);
			result.push(`    const value = '${'wrapped-content-'.repeat(8 + (i % 9))}';`);
			result.push(`    return value + '${i % 3 === 0 ? 'short' : 'another-variable-length-fragment-'.repeat(5)}';`);
			result.push('  }');
		}
		result.push('}');
		return result.join('\n');
	};

	// Ask the git extension to re-scan, then wait until `pred` sees the expected state. Every test calls
	// this after mutating the working tree so assertions never race the extension's async refresh.
	const refreshUntil = async (pred: () => boolean, what: string) => {
		await repo.status();
		await poll(pred, what);
	};

	// Change-list probes against the live vscode.git state.
	const inWorkingTree = (rel: string, status?: number) =>
		(repo.state.workingTreeChanges ?? []).some(
			(c: any) => c.uri.path === wsUri(rel).path && (status === undefined || c.status === status)
		);
	const inIndex = (rel: string, status?: number) =>
		(repo.state.indexChanges ?? []).some(
			(c: any) => c.uri.path === wsUri(rel).path && (status === undefined || c.status === status)
		);
	// Untracked can live in workingTreeChanges (git.untrackedChanges="mixed", the default) OR in the
	// dedicated untrackedChanges list ("separate") — accept either so the suite passes on any user setting.
	const isUntracked = (rel: string) =>
		inWorkingTree(rel, 7 /* UNTRACKED */) ||
		(repo.state.untrackedChanges ?? []).some((c: any) => c.uri.path === wsUri(rel).path);

	// Open a file as a PLAIN pinned editor with the cursor at `line` (how an untracked file shows up).
	const openPlainAt = async (rel: string, line: number): Promise<vscode.TextEditor> => {
		const editor = await vscode.window.showTextDocument(wsUri(rel), { preview: false });
		const pos = new vscode.Position(line, 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
		// VS Code remembers scroll state by URI even after close/recreate. Several tests deliberately reuse
		// zz_new.txt, so resetting only the caret can leave the next test's viewport at the prior test's L16.
		await poll(() => editor.visibleRanges[0]?.start.line === line, `${rel} viewport to reset to line ${line}`);
		return editor;
	};

	const nextChange = () => vscode.commands.executeCommand('better-git-vscode.next-scm-change');
	const previousChange = () => vscode.commands.executeCommand('better-git-vscode.previous-scm-change');

	// Wait until the active tab shows `rel` — the standard "navigation advanced to file X" assertion.
	const expectActiveTab = (rel: string) =>
		poll(() => activeTabPath() === wsUri(rel).path, `active tab to become ${rel} (was ${activeTabPath()})`);

	// Wait until the cursor in `rel`'s visible editor sits on `line` — the standard stepping assertion.
	const expectCursorAt = (rel: string, line: number) =>
		poll(() => {
			const e = visibleEditorFor(wsUri(rel));
			return e && e.selection.active.line === line ? e : undefined;
		}, `cursor in ${rel} to reach line ${line} (at ${visibleEditorFor(wsUri(rel))?.selection.active.line})`);

	// A cursor move alone is NOT proof that new-file review scrolled: the v1.2.15 regression moved the caret
	// from L1 to L6 while leaving the viewport at L1, then every later NEXT recomputed L6 and stuck forever.
	const expectViewportTopAt = (rel: string, line: number) =>
		poll(() => {
			const e = visibleEditorFor(wsUri(rel));
			return e?.visibleRanges[0]?.start.line === line ? e : undefined;
		}, `viewport in ${rel} to start at line ${line} (at ${visibleEditorFor(wsUri(rel))?.visibleRanges[0]?.start.line})`);
	const expectViewportTop = (rel: string, pred: (line: number) => boolean, description: string) =>
		poll(() => {
			const e = visibleEditorFor(wsUri(rel));
			const top = e?.visibleRanges[0]?.start.line;
			return top !== undefined && pred(top) ? e : undefined;
		}, `viewport in ${rel} ${description} (at ${visibleEditorFor(wsUri(rel))?.visibleRanges[0]?.start.line})`);

	suiteSetup(async function () {
		// One-time host warm-up can be slow (git ext activation + repo discovery).
		this.timeout(120_000);
		ws = vscode.workspace.workspaceFolders![0].uri.fsPath;

		// Activate the built-in git extension and wait for it to discover the fixture repo.
		const gitExt = vscode.extensions.getExtension<any>('vscode.git')!;
		await gitExt.activate();
		const api = gitExt.exports.getAPI(1);
		repo = await poll(() => api.repositories[0], 'vscode.git to discover the fixture repository', 60_000);
		baseSha = git('rev-parse HEAD');
		// Ask git itself for the empty-tree id of THIS repo's object format (SHA-1 vs SHA-256).
		EMPTY_TREE = git('hash-object -t tree /dev/null');

		// Make sure OUR extension is active before the first executeCommand (onStartupFinished usually
		// beats us here, but don't rely on the race).
		await vscode.extensions.getExtension<any>('EthanSK.better-git-vscode')!.activate();
	});

	// Every test starts from a pristine base commit + empty editor area, so tests are order-independent
	// and self-cleaning (rename/delete/stage state from a previous test can't leak in).
	setup(async () => {
		git(`reset --hard ${baseSha}`);
		git('clean -fdq');
		await refreshUntil(
			() =>
				(repo.state.workingTreeChanges ?? []).length === 0 &&
				(repo.state.indexChanges ?? []).length === 0 &&
				// git.untrackedChanges="separate" keeps untracked files in their own list — it must drain
				// too, or an untracked file from the previous test could leak into this one's change list.
				(repo.state.untrackedChanges ?? []).length === 0,
			'clean git state after reset'
		);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// UNTRACKED NEW FILE — the feature itself
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('untracked new file: repeated next scrolls +5 each time; previous mirrors -5', async () => {
		// Deliberately much taller than any test-host viewport. A 30-line fixture could fit on a large runner
		// and accidentally exercise cross-file fall-through instead of the production 243-line-file path.
		write('zz_new.txt', lines(240, 'new'));
		await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
		await openPlainAt('zz_new.txt', 0);

		await nextChange();
		await expectCursorAt('zz_new.txt', 5);
		await expectViewportTopAt('zz_new.txt', 5);
		await nextChange();
		await expectCursorAt('zz_new.txt', 10);
		await expectViewportTopAt('zz_new.txt', 10);
		await previousChange();
		await expectCursorAt('zz_new.txt', 5);
		await expectViewportTopAt('zz_new.txt', 5);
		await previousChange();
		await expectCursorAt('zz_new.txt', 0);
		await expectViewportTopAt('zz_new.txt', 0);
		// stepping never leaves the file
		assert.strictEqual(activeTabPath(), wsUri('zz_new.txt').path);
	});

	test('reveal from an out-of-workspace worktree diff adds its root and opens the editable file', async () => {
		const worktreePath = process.env.BGV_REVEAL_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the linked worktree fixture path');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousSetting = config.inspect<boolean>('autoAddWorktreeOnReveal')?.globalValue;
		const changedRelativePath = path.join('committed', 'mod_a.txt');
		const changedPath = path.join(worktreePath, changedRelativePath);
		const changedUri = vscode.Uri.file(changedPath);
		const originalPath = path.join(path.dirname(worktreePath), 'mod_a-original.txt');
		const originalUri = vscode.Uri.file(originalPath);

		try {
			await config.update('autoAddWorktreeOnReveal', true, vscode.ConfigurationTarget.Global);
			fs.copyFileSync(changedPath, originalPath);
			fs.appendFileSync(changedPath, 'revealed from linked worktree\n');

			// Open a real side-by-side diff whose modified side is the worktree file. The built-in git provider
			// cannot serve a git: index URI until its repository is in the workspace — that discovery is exactly
			// what this command is adding — so this file:-backed diff isolates the same TabInputTextDiff resolver.
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				changedUri,
				'mod_a.txt (Linked Worktree)',
				{ preview: false }
			);
			await poll(
				() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'linked-worktree staged diff to become active'
			);
			assert.strictEqual(
				vscode.workspace.getWorkspaceFolder(changedUri),
				undefined,
				'test precondition: linked worktree must start outside Explorer'
			);

			await vscode.commands.executeCommand('better-git-vscode.reveal-current-file-in-explorer');

			await poll(
				() => vscode.workspace.getWorkspaceFolder(changedUri),
				'linked worktree root to be added to the workspace'
			);
			await poll(() => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				return input instanceof vscode.TabInputText && input.uri.path === changedUri.path;
			}, 'reveal command to open the editable linked-worktree file');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath, stdio: 'pipe' });
			fs.rmSync(originalPath, { force: true });
			await config.update('autoAddWorktreeOnReveal', previousSetting, vscode.ConfigurationTarget.Global);
		}
	});

	test('reveal leaves an out-of-workspace worktree alone when auto-add is disabled', async () => {
		const worktreePath = process.env.BGV_DISABLED_REVEAL_WORKTREE_PATH;
		assert.ok(worktreePath, 'runTest.ts must provide the disabled linked-worktree fixture path');
		const config = vscode.workspace.getConfiguration('better-git-vscode');
		const previousSetting = config.inspect<boolean>('autoAddWorktreeOnReveal')?.globalValue;
		const changedRelativePath = path.join('committed', 'mod_a.txt');
		const changedPath = path.join(worktreePath, changedRelativePath);
		const changedUri = vscode.Uri.file(changedPath);
		const originalPath = path.join(path.dirname(worktreePath), 'mod_a-disabled-original.txt');
		const originalUri = vscode.Uri.file(originalPath);

		try {
			await config.update('autoAddWorktreeOnReveal', false, vscode.ConfigurationTarget.Global);
			fs.copyFileSync(changedPath, originalPath);
			fs.appendFileSync(changedPath, 'opened without adding linked worktree\n');
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				changedUri,
				'mod_a.txt (Auto-add Disabled)',
				{ preview: false }
			);
			await poll(
				() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
				'disabled linked-worktree diff to become active'
			);

			await vscode.commands.executeCommand('better-git-vscode.reveal-current-file-in-explorer');

			assert.strictEqual(
				vscode.workspace.getWorkspaceFolder(changedUri),
				undefined,
				'auto-add disabled must leave the worktree outside the workspace'
			);
			await poll(() => {
				const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
				return input instanceof vscode.TabInputText && input.uri.path === changedUri.path;
			}, 'disabled reveal command to still open the editable linked-worktree file');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			execFileSync('git', ['reset', '--hard', baseSha], { cwd: worktreePath, stdio: 'pipe' });
			fs.rmSync(originalPath, { force: true });
			await config.update('autoAddWorktreeOnReveal', previousSetting, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked new file: rapid repeated next presses are serialized and none are lost', async () => {
		write('zz_new.txt', lines(240, 'new'));
		await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
		await openPlainAt('zz_new.txt', 0);

		// Do not wait between presses: this is key-repeat / a quick double-tap. Before the shared navigation
		// queue both calls could read viewport top=0 and target L6, losing the second press.
		await Promise.all([nextChange(), nextChange(), nextChange()]);
		await expectCursorAt('zz_new.txt', 15);
		await expectViewportTopAt('zz_new.txt', 15);
	});

	test('untracked wrapped file: SCM-focused next/previous remain exact five-line steps', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousStickyScroll = editorConfig.inspect<boolean>('stickyScroll.enabled')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', true, vscode.ConfigurationTarget.Global);
			write('zz_wrapped_new.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_new.ts'), 'zz_wrapped_new.ts to appear as untracked');
			await openPlainAt('zz_wrapped_new.ts', 0);

			// This is Ethan's exact path: the SCM tree owns keyboard focus while the active plain editor is the
			// untracked file. v1.2.22 used visibleRanges.top as both success criterion and cursor fallback; wrapped
			// and sticky layouts can report that top a few logical lines away, producing +7/-3 drift or a repeat.
			await vscode.commands.executeCommand('workbench.view.scm');
			await nextChange();
			await expectCursorAt('zz_wrapped_new.ts', 5);
			await nextChange();
			await expectCursorAt('zz_wrapped_new.ts', 10);
			await previousChange();
			await expectCursorAt('zz_wrapped_new.ts', 5);
			await previousChange();
			await expectCursorAt('zz_wrapped_new.ts', 0);
			assert.strictEqual(activeTabPath(), wsUri('zz_wrapped_new.ts').path);
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', previousStickyScroll, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked wrapped file: rapid queued next and direction reversals lose no steps', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousStickyScroll = editorConfig.inspect<boolean>('stickyScroll.enabled')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', true, vscode.ConfigurationTarget.Global);
			write('zz_wrapped_rapid.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_rapid.ts'), 'zz_wrapped_rapid.ts to appear as untracked');
			await openPlainAt('zz_wrapped_rapid.ts', 0);
			await vscode.commands.executeCommand('workbench.view.scm');

			await Promise.all([nextChange(), nextChange(), nextChange(), nextChange()]);
			const afterRapidNext = await expectCursorAt('zz_wrapped_rapid.ts', 20);
			assert.ok(afterRapidNext.visibleRanges[0].start.line > 0, 'rapid wrapped stepping did not move the viewport');

			// Queue order: 20 -> 15 -> 20 -> 15 -> 10 -> 15. This catches stale viewport reads in either direction.
			await Promise.all([previousChange(), nextChange(), previousChange(), previousChange(), nextChange()]);
			await expectCursorAt('zz_wrapped_rapid.ts', 15);
			assert.strictEqual(activeTabPath(), wsUri('zz_wrapped_rapid.ts').path);
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
			await editorConfig.update('stickyScroll.enabled', previousStickyScroll, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked wrapped file: editor/SCM focus switches preserve one shared five-line sequence', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			write('zz_wrapped_focus.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_focus.ts'), 'zz_wrapped_focus.ts to appear as untracked');
			await openPlainAt('zz_wrapped_focus.ts', 0);

			await nextChange(); // editor focused
			await expectCursorAt('zz_wrapped_focus.ts', 5);
			await vscode.commands.executeCommand('workbench.view.scm');
			await nextChange(); // SCM focused
			await expectCursorAt('zz_wrapped_focus.ts', 10);
			await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			await previousChange(); // editor focused again
			await expectCursorAt('zz_wrapped_focus.ts', 5);
			await vscode.commands.executeCommand('workbench.view.scm');
			await previousChange(); // SCM focused again
			await expectCursorAt('zz_wrapped_focus.ts', 0);
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked wrapped file: custom jump remains exact with SCM focus and rapid presses', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const navConfig = vscode.workspace.getConfiguration('better-git-vscode');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		const previousJump = navConfig.inspect<number>('newFileNavLineJump')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			await navConfig.update('newFileNavLineJump', 7, vscode.ConfigurationTarget.Global);
			write('zz_wrapped_custom.ts', wrappedTypeScriptFixture());
			await refreshUntil(() => isUntracked('zz_wrapped_custom.ts'), 'zz_wrapped_custom.ts to appear as untracked');
			await openPlainAt('zz_wrapped_custom.ts', 0);
			await vscode.commands.executeCommand('workbench.view.scm');

			await Promise.all([nextChange(), nextChange(), nextChange()]);
			await expectCursorAt('zz_wrapped_custom.ts', 21);
			await previousChange();
			await expectCursorAt('zz_wrapped_custom.ts', 14);
		} finally {
			await navConfig.update('newFileNavLineJump', previousJump, vscode.ConfigurationTarget.Global);
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('newFileNavLineJump custom value is respected', async () => {
		const cfg = () => vscode.workspace.getConfiguration('better-git-vscode');
		await cfg().update('newFileNavLineJump', 7, vscode.ConfigurationTarget.Global);
		try {
			await poll(() => cfg().get<number>('newFileNavLineJump') === 7, 'custom new-file jump setting to become visible');
			write('zz_new.txt', lines(240, 'new'));
			await refreshUntil(() => isUntracked('zz_new.txt'), 'zz_new.txt to appear as untracked');
			await openPlainAt('zz_new.txt', 0);
			await expectActiveTab('zz_new.txt');
			await expectCursorAt('zz_new.txt', 0);

			await nextChange();
			await expectCursorAt('zz_new.txt', 7);
			await expectViewportTopAt('zz_new.txt', 7);
		} finally {
			// always restore, even on assertion failure — a leaked setting would skew later tests
			await cfg().update('newFileNavLineJump', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('untracked file at bottom edge: next falls through to the next FILE', async () => {
		write('aa_new.txt', lines(10, 'a'));
		write('ab_next.txt', lines(5, 'b'));
		await refreshUntil(() => isUntracked('aa_new.txt') && isUntracked('ab_next.txt'), 'both untracked files listed');
		const editor = await openPlainAt('aa_new.txt', 0);
		// park the cursor on the LAST line -> next press is at the edge
		const last = editor.document.lineCount - 1;
		editor.selection = new vscode.Selection(new vscode.Position(last, 0), new vscode.Position(last, 0));

		await nextChange();
		await expectActiveTab('ab_next.txt'); // sorted after aa_new.txt, so it's the "next file"
	});

	test('untracked file at top edge: previous falls through to the previous FILE', async () => {
		write('aa_new.txt', lines(10, 'a'));
		write('ab_next.txt', lines(5, 'b'));
		await refreshUntil(() => isUntracked('aa_new.txt') && isUntracked('ab_next.txt'), 'both untracked files listed');
		await openPlainAt('ab_next.txt', 0); // cursor at very top -> previous is at the edge

		await previousChange();
		await expectActiveTab('aa_new.txt');
	});

	test('very short new file already fully visible: final partial step lands at EOF before rollover', async () => {
		write('aa_short.txt', lines(3, 's')); // 3 lines, no trailing newline -> last line index 2
		write('ab_other.txt', lines(5, 'o'));
		await refreshUntil(() => isUntracked('aa_short.txt') && isUntracked('ab_other.txt'), 'both untracked files listed');
		await openPlainAt('aa_short.txt', 0);

		await nextChange();
		await expectCursorAt('aa_short.txt', 2); // consume the remaining two-line step and visibly park at EOF
		assert.strictEqual(activeTabPath(), wsUri('aa_short.txt').path, 'final partial step skipped straight to the next file');

		await nextChange(); // only the following press may roll over
		await expectActiveTab('ab_other.txt');
	});

	test('untracked file with EOF already visible: next still lands at EOF before rollover', async () => {
		write('aa_new.txt', lines(60, 'a'));
		write('ab_next.txt', lines(5, 'b'));
		await refreshUntil(() => isUntracked('aa_new.txt') && isUntracked('ab_next.txt'), 'both untracked files listed');
		const editor = await openPlainAt('aa_new.txt', 0);
		const last = editor.document.lineCount - 1;
		const nearEnd = last - 3; // fewer than the configured five lines remain
		const pos = new vscode.Position(nearEnd, 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
		await poll(
			() => editor.visibleRanges[editor.visibleRanges.length - 1]?.end.line === last,
			'EOF to be visible while caret remains above it'
		);

		await nextChange();
		await expectCursorAt('aa_new.txt', last);
		assert.strictEqual(activeTabPath(), wsUri('aa_new.txt').path, 'visible EOF caused premature file rollover');

		await nextChange();
		await expectActiveTab('ab_next.txt');
	});

	test('untracked file with start already visible: previous steps to line 1 before rollover', async () => {
		write('aa_previous.txt', lines(5, 'a'));
		write('ab_current.txt', lines(12, 'b'));
		await refreshUntil(
			() => isUntracked('aa_previous.txt') && isUntracked('ab_current.txt'),
			'both untracked files listed'
		);
		const editor = await openPlainAt('ab_current.txt', 0); // the whole file fits, so line 1 is already visible
		const last = editor.document.lineCount - 1;
		const pos = new vscode.Position(last, 0);
		editor.selection = new vscode.Selection(pos, pos);

		await previousChange();
		await expectCursorAt('ab_current.txt', 6);
		await previousChange();
		await expectCursorAt('ab_current.txt', 1);
		await previousChange();
		await expectCursorAt('ab_current.txt', 0); // final one-line partial step
		assert.strictEqual(activeTabPath(), wsUri('ab_current.txt').path, 'visible file start caused premature rollover');

		await previousChange();
		await expectActiveTab('aa_previous.txt');
	});

	test('untracked EOF direction reversal continues from the current caret', async () => {
		write('zz_reverse.txt', lines(13, 'r'));
		await refreshUntil(() => isUntracked('zz_reverse.txt'), 'zz_reverse.txt to appear as untracked');
		const editor = await openPlainAt('zz_reverse.txt', 0);
		const pos = new vscode.Position(10, 0);
		editor.selection = new vscode.Selection(pos, pos);

		await nextChange();
		await expectCursorAt('zz_reverse.txt', 12); // final +2 lands at EOF
		await previousChange();
		await expectCursorAt('zz_reverse.txt', 7); // reverse from EOF, never jump to another file/bottom
		await nextChange();
		await expectCursorAt('zz_reverse.txt', 12);
		assert.strictEqual(activeTabPath(), wsUri('zz_reverse.txt').path);
	});

	test('untracked wrapped EOF: rapid final-step plus rollover waits until EOF is presented', async () => {
		const editorConfig = vscode.workspace.getConfiguration('editor');
		const previousWordWrap = editorConfig.inspect<string>('wordWrap')?.globalValue;
		try {
			await editorConfig.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
			write(
				'aa_wrapped_boundary.ts',
				Array.from({ length: 40 }, (_, i) => `const wrappedBoundary${i} = '${'very-long-content-'.repeat(120)}';`).join('\n')
			);
			write('ab_next.txt', lines(5, 'b'));
			await refreshUntil(
				() => isUntracked('aa_wrapped_boundary.ts') && isUntracked('ab_next.txt'),
				'both untracked files listed'
			);
			const editor = await openPlainAt('aa_wrapped_boundary.ts', 0);
			const last = editor.document.lineCount - 1;
			const nearEnd = last - 3;
			const pos = new vscode.Position(nearEnd, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
			await poll(
				() =>
					editor.visibleRanges.some((range) => nearEnd >= range.start.line && nearEnd <= range.end.line) &&
					!editor.visibleRanges.some((range) => last >= range.start.line && last <= range.end.line),
				'near-EOF caret visible while the heavily wrapped EOF remains off-screen'
			);
			await vscode.commands.executeCommand('workbench.view.scm');

			// First queued press must render/pin EOF; only the second may roll over. Without awaiting the bottom
			// reveal, the second press can see stale visibleRanges and consume an unintended extra edge-reveal step.
			await Promise.all([nextChange(), nextChange()]);
			await expectActiveTab('ab_next.txt');
		} finally {
			await editorConfig.update('wordWrap', previousWordWrap, vscode.ConfigurationTarget.Global);
		}
	});

	test('empty new file: next advances to the next file immediately', async () => {
		write('aa_empty.txt', '');
		write('ab_other.txt', lines(5, 'o'));
		await refreshUntil(() => isUntracked('aa_empty.txt') && isUntracked('ab_other.txt'), 'both untracked files listed');
		await openPlainAt('aa_empty.txt', 0); // an empty doc has exactly 1 line -> cursor already at the edge

		await nextChange();
		await expectActiveTab('ab_other.txt');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// MODIFIED FILE — THE v1.2.0 REGRESSION GUARD
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('MODIFIED file: next/previous do HUNK navigation, never the 5-line step', async () => {
		// Two well-separated single-line edits -> hunks starting at 0-based lines 4 and 24.
		const content = lines(40, 'mod_a').split('\n');
		content[4] = 'mod_a line 5 EDITED';
		content[24] = 'mod_a line 25 EDITED';
		write('committed/mod_a.txt', content.join('\n') + '\n');
		// A second modified file so the run-out-of-hunks fall-through has a deterministic landing target.
		const d = lines(10, 'mod_d').split('\n');
		d[3] = 'mod_d line 4 EDITED';
		write('committed/mod_d.txt', d.join('\n') + '\n');
		await refreshUntil(
			() => inWorkingTree('committed/mod_a.txt', 5 /* MODIFIED */) && inWorkingTree('committed/mod_d.txt', 5),
			'both files to appear as MODIFIED'
		);

		// Open the working-tree diff exactly like clicking the SCM row.
		await vscode.commands.executeCommand('git.openChange', wsUri('committed/mod_a.txt'));
		// Wait for the side-by-side diff to actually render: both sides visible (the original side is a
		// git:-scheme editor). Pressing next before the diff model is ready would race hunk detection.
		await poll(
			() =>
				vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
				visibleEditorFor(wsUri('committed/mod_a.txt')) !== undefined &&
				vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'git' && uriFilePath(e.document.uri) === wsUri('committed/mod_a.txt').path),
			'mod_a diff editor to render both sides'
		);
		await sleep(500); // small grace period for the diff computation itself
		const modifiedSide = visibleEditorFor(wsUri('committed/mod_a.txt'))!;
		modifiedSide.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		// From line 0 the next HUNK starts at line 4. If the v1.2.0 bug regressed, the cursor would land
		// on line 5 (0 + jump) instead — assert both the hunk line and explicitly not-the-step line.
		await nextChange();
		const afterFirst = await expectCursorAt('committed/mod_a.txt', 4);
		assert.notStrictEqual(afterFirst.selection.active.line, 5, 'cursor moved by the 5-line step on a MODIFIED file — v1.2.0 regression is back');

		// Second hunk: line 24 (a 5-line step from 4 would be 9).
		await nextChange();
		await expectCursorAt('committed/mod_a.txt', 24);

		// Previous goes BACK to the first hunk (a 5-line step back from 24 would be 19).
		await previousChange();
		await expectCursorAt('committed/mod_a.txt', 4);

		// Run past the last hunk -> falls through to the next changed FILE (mod_d), as always.
		await nextChange(); // back to 24
		await expectCursorAt('committed/mod_a.txt', 24);
		await nextChange(); // out of hunks
		await expectActiveTab('committed/mod_d.txt');
	});

	test('MODIFIED tall hunk: repeated/rapid next scrolls down and previous scrolls back up', async () => {
		const content = lines(260, 'tall_e').split('\n');
		for (let i = 10; i <= 229; i++) {
			content[i] = `tall_e EDITED line ${i + 1}`;
		}
		write('committed/tall_e.txt', content.join('\n'));
		await refreshUntil(() => inWorkingTree('committed/tall_e.txt', 5 /* MODIFIED */), 'tall_e to appear as MODIFIED');

		await vscode.commands.executeCommand('git.openChange', wsUri('committed/tall_e.txt'));
		await poll(
			() =>
				vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
				visibleEditorFor(wsUri('committed/tall_e.txt')) !== undefined,
			'tall_e diff editor to render'
		);
		await sleep(500);
		const modifiedSide = visibleEditorFor(wsUri('committed/tall_e.txt'))!;
		modifiedSide.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		// First NEXT lands at the tall changed run's start and explicitly presents it at viewport top.
		await nextChange();
		const landed = await expectViewportTop('committed/tall_e.txt', top => top >= 7 && top <= 10, 'to land at the tall hunk start');
		const startTop = landed.visibleRanges[0].start.line;

		// Two immediate NEXT presses must both survive the shared queue and move the viewport farther down.
		// Put keyboard focus in Source Control first: Ethan's real review flow clicks SCM rows with preserveFocus,
		// so the scroll command must still target the active diff editor while focus lives in the sidebar.
		await vscode.commands.executeCommand('workbench.view.scm');
		await Promise.all([nextChange(), nextChange()]);
		const down = await expectViewportTop('committed/tall_e.txt', top => top > startTop + 20, 'to advance through the tall hunk');
		const downTop = down.visibleRanges[0].start.line;
		assert.strictEqual(down.selection.active.line, downTop, 'tall-hunk caret did not remain pinned to viewport top');

		await previousChange();
		const up = await expectViewportTop('committed/tall_e.txt', top => top < downTop, 'to move back up through the tall hunk');
		assert.strictEqual(up.selection.active.line, up.visibleRanges[0].start.line, 'reverse tall-hunk caret/view coupling broke');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// STAGED-NEW (INDEX_ADDED)
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('staged-new tall file opened as a PLAIN editor: still scroll-steps ±5', async () => {
		write('aa_staged.txt', lines(240, 'staged'));
		git('add aa_staged.txt');
		await refreshUntil(
			() => inIndex('aa_staged.txt', 1 /* INDEX_ADDED */) && !inWorkingTree('aa_staged.txt'),
			'aa_staged.txt to be INDEX_ADDED with a clean working tree'
		);
		await openPlainAt('aa_staged.txt', 0);

		await nextChange();
		await expectCursorAt('aa_staged.txt', 5);
		await expectViewportTopAt('aa_staged.txt', 5);
		await previousChange();
		await expectCursorAt('aa_staged.txt', 0);
		await expectViewportTopAt('aa_staged.txt', 0);
	});

	test('staged-new file opened as its empty-original DIFF: normal nav, advances to the next file (no crawl)', async () => {
		write('aa_staged.txt', lines(20, 'staged'));
		git('add aa_staged.txt');
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('aa_staged.txt', 1) && isUntracked('ab_helper.txt'),
			'staged + helper files listed'
		);

		// Open the exact staged diff openChangeEntry builds for INDEX_ADDED: empty-tree vs index.
		const uri = wsUri('aa_staged.txt');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, EMPTY_TREE), toGitUri(uri, ''), 'aa_staged.txt (Index)', { preview: true });
		await poll(
			() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
			'staged diff tab to open'
		);
		await sleep(500);

		// v1.2.1 DESIGN DECISION under test: a diff tab (even the fully-added one) uses NORMAL navigation.
		// The whole file is one change, so next falls through to the next file — never a 5-line crawl and
		// NEVER a silent no-op. (Changes list: staged group first -> aa_staged is index 0, helper is next.)
		await nextChange();
		await expectActiveTab('ab_helper.txt');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// DELETED FILES — must never step, must always advance (the "does nothing on deleted" bug)
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('DELETED file (unstaged): next does NOT 5-line step, advances to the next file', async () => {
		fs.rmSync(path.join(ws, 'committed/del_b.txt'));
		write('committed/zz_helper.txt', lines(5, 'h')); // deterministic landing target, sorted after del_b
		await refreshUntil(
			() => inWorkingTree('committed/del_b.txt', 6 /* DELETED */) && isUntracked('committed/zz_helper.txt'),
			'deletion + helper to be listed'
		);

		// Open the deleted file the way the SCM row does: shows HEAD content as a plain git:-scheme editor.
		await vscode.commands.executeCommand('git.openChange', wsUri('committed/del_b.txt'));
		await poll(() => activeTabPath() === wsUri('committed/del_b.txt').path, 'deleted-file view to open');
		await sleep(300);

		await nextChange();
		// The core assertion for Ethan's "on a deleted file it does nothing" report: the press must
		// ADVANCE (deleted content is removed, not added — nothing to scroll through).
		await expectActiveTab('committed/zz_helper.txt');
	});

	test('STAGED deletion (INDEX_DELETED): next does NOT step, advances to the next file', async () => {
		git('rm -q committed/del_b.txt');
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('committed/del_b.txt', 2 /* INDEX_DELETED */) && isUntracked('ab_helper.txt'),
			'staged deletion + helper to be listed'
		);

		// Open the exact staged diff openChangeEntry builds for INDEX_DELETED: HEAD vs empty-tree.
		const uri = wsUri('committed/del_b.txt');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(uri, 'HEAD'), toGitUri(uri, EMPTY_TREE), 'del_b.txt (Index)', { preview: true });
		await poll(
			() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
			'staged-deletion diff tab to open'
		);
		await sleep(500);

		await nextChange();
		await expectActiveTab('ab_helper.txt'); // staged group (del_b) is index 0 -> next is the helper
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// RENAMED FILE — git's classic "delete+add" trap: must NOT be treated as added
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('RENAMED file (INDEX_RENAMED): next does NOT step, navigates normally to the next file', async () => {
		git('mv committed/ren_c.txt committed/ren_c_renamed.txt');
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('committed/ren_c_renamed.txt', 3 /* INDEX_RENAMED */) && isUntracked('ab_helper.txt'),
			'rename + helper to be listed'
		);

		// Open the staged rename diff the way openChangeEntry does: HEAD blob at the ORIGINAL path vs
		// index blob at the NEW path. Content is identical (pure rename) -> zero hunks.
		const oldUri = wsUri('committed/ren_c.txt');
		const newUri = wsUri('committed/ren_c_renamed.txt');
		await vscode.commands.executeCommand('vscode.diff', toGitUri(oldUri, 'HEAD'), toGitUri(newUri, ''), 'ren_c_renamed.txt (Index)', { preview: true });
		await poll(
			() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
			'rename diff tab to open'
		);
		await sleep(500);

		// A pure rename has no hunks -> next must fall straight through to the next file. If the rename
		// were mis-detected as "fully added" (the delete+add trap), we'd see a 5-line crawl instead.
		await nextChange();
		await expectActiveTab('ab_helper.txt');
	});

	// ────────────────────────────────────────────────────────────────────────────────────────
	// DUAL-STATE (INDEX_ADDED + MODIFIED) — the stage-then-edit hijack guard
	// ────────────────────────────────────────────────────────────────────────────────────────

	test('staged-new file edited again (dual-state): working-tree diff uses HUNK navigation, not stepping', async () => {
		// Stage a new 30-line file, then edit ONE line -> the file is INDEX_ADDED *and* MODIFIED.
		write('aa_dual.txt', lines(30, 'dual'));
		git('add aa_dual.txt');
		const edited = lines(30, 'dual').split('\n');
		edited[9] = 'dual line 10 EDITED';
		write('aa_dual.txt', edited.join('\n'));
		write('ab_helper.txt', lines(5, 'h'));
		await refreshUntil(
			() => inIndex('aa_dual.txt', 1 /* INDEX_ADDED */) && inWorkingTree('aa_dual.txt', 5 /* MODIFIED */) && isUntracked('ab_helper.txt'),
			'dual-state (INDEX_ADDED + MODIFIED) to be listed'
		);

		// The working-tree diff (index vs working tree) has exactly one real hunk at line 9. v1.2.0 treated
		// this file as "fully added" purely because an INDEX_ADDED entry existed and crawled 5 lines instead.
		await vscode.commands.executeCommand('git.openChange', wsUri('aa_dual.txt'));
		await poll(
			() =>
				vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff &&
				visibleEditorFor(wsUri('aa_dual.txt')) !== undefined,
			'dual-state working-tree diff to render'
		);
		await sleep(500);
		const editor = visibleEditorFor(wsUri('aa_dual.txt'))!;
		editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

		await nextChange();
		// hunk starts at 0-based line 9 — a 5-line step would land on line 5
		const after = await expectCursorAt('aa_dual.txt', 9);
		assert.notStrictEqual(after.selection.active.line, 5, 'dual-state file got the 5-line step — the stage-then-edit hijack is back');
	});
});
