import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync, execSync } from 'child_process';

import { runTests } from '@vscode/test-electron';

// E2E test launcher (v1.2.1). Builds a REAL git-repo fixture workspace in a temp dir BEFORE launching the
// VS Code test host, then opens the host on that folder. The fixture must exist up-front so the built-in
// vscode.git extension discovers the repository during startup — creating the repo mid-test is flaky
// (repo discovery isn't guaranteed to notice a brand-new .git promptly).
//
// IMPORTANT: we deliberately do NOT pass --disable-extensions — the navigation logic under test depends on
// the BUILT-IN vscode.git extension (its API provides indexChanges/workingTreeChanges/untrackedChanges),
// and --disable-extensions would disable built-ins too, silently breaking every git-state assertion.
async function main() {
	// Created before the try so the finally can clean it up whether the suite passed or failed.
	let fixturePath: string | undefined;
	let auxiliaryPath: string | undefined;
	let workspaceFilePath: string | undefined;
	let revealWorktreeParent: string | undefined;
	let revealWorktreePath: string | undefined;
	let disabledRevealWorktreePath: string | undefined;
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// ── Build the fixture repo ─────────────────────────────────────────────────────────────
		fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bgv-e2e-'));
		// Start the host as a real multi-root workspace so the reveal-worktree regression test can add a third
		// folder without triggering VS Code's single-folder -> multi-root extension-host restart mid-Mocha run.
		// The first folder remains the git fixture, preserving every existing test's workspaceFolders[0] contract.
		auxiliaryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bgv-e2e-aux-'));
		workspaceFilePath = path.join(os.tmpdir(), `bgv-e2e-${process.pid}-${Date.now()}.code-workspace`);
		fs.writeFileSync(
			workspaceFilePath,
			JSON.stringify({ folders: [{ path: fixturePath }, { path: auxiliaryPath }] })
		);
		const run = (cmd: string) => execSync(cmd, { cwd: fixturePath, stdio: 'pipe' });
		run('git init -b main');
		// Repo-local identity + no signing, so commits work on any machine (CI, the Mac Mini, fresh
		// user accounts) without relying on global git config.
		run('git config user.email "e2e@test.local"');
		run('git config user.name "BGV E2E"');
		run('git config commit.gpgsign false');

		// Base files for the "tracked" scenarios. Tests mutate these (modify/delete/rename) and the suite
		// resets to this base commit between tests, so the content here must stay deterministic.
		const lines = (n: number, prefix: string) =>
			Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n') + '\n';
		fs.mkdirSync(path.join(fixturePath, 'committed'));
		fs.writeFileSync(path.join(fixturePath, 'committed', 'mod_a.txt'), lines(40, 'mod_a')); // 2-hunk modified-file test
		fs.writeFileSync(path.join(fixturePath, 'committed', 'mod_d.txt'), lines(10, 'mod_d')); // second modified file (fall-through target)
		fs.writeFileSync(path.join(fixturePath, 'committed', 'tall_e.txt'), lines(260, 'tall_e')); // tall contiguous-hunk viewport stepping
		fs.writeFileSync(path.join(fixturePath, 'committed', 'del_b.txt'), lines(20, 'del_b')); // deleted-file tests
		fs.writeFileSync(path.join(fixturePath, 'committed', 'ren_c.txt'), lines(20, 'ren_c')); // rename test
		run('git add -A');
		run('git commit -m "base"');

		// Keep the reveal regression's linked worktree alive until the Extension Development Host exits.
		// Removing a newly-discovered repo while VS Code's git extension still has delayed status checks queued
		// produces noisy "Repository not initialized" rejections even though the behavior test passed.
		revealWorktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'bgv-reveal-worktree-'));
		revealWorktreePath = path.join(revealWorktreeParent, 'linked-worktree');
		disabledRevealWorktreePath = path.join(revealWorktreeParent, 'disabled-linked-worktree');
		execFileSync('git', ['worktree', 'add', '--detach', revealWorktreePath], { cwd: fixturePath, stdio: 'pipe' });
		execFileSync('git', ['worktree', 'add', '--detach', disabledRevealWorktreePath], {
			cwd: fixturePath,
			stdio: 'pipe',
		});
		process.env.BGV_REVEAL_WORKTREE_PATH = revealWorktreePath;
		process.env.BGV_DISABLED_REVEAL_WORKTREE_PATH = disabledRevealWorktreePath;

		// Download VS Code, unzip it and run the integration tests against the fixture workspace.
		// CI normally downloads the requested stable build. Local diagnosis can set BGV_VSCODE_EXECUTABLE_PATH
		// to reuse an already-installed Code binary, avoiding a 280MB download and making it practical to run
		// the real E2E suite before every release (v1.2.15/v1.2.17 were shipped without it on the MBP).
		const vscodeExecutablePath = process.env.BGV_VSCODE_EXECUTABLE_PATH;
		await runTests({
			...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				workspaceFilePath,
				'--disable-workspace-trust', // tmp-dir fixture would otherwise trigger the trust prompt and block the git extension
				'--skip-welcome',
				'--skip-release-notes',
				'--disable-telemetry',
			],
		});
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	} finally {
		delete process.env.BGV_REVEAL_WORKTREE_PATH;
		delete process.env.BGV_DISABLED_REVEAL_WORKTREE_PATH;
		if (fixturePath) {
			for (const worktreePath of [revealWorktreePath, disabledRevealWorktreePath]) {
				if (!worktreePath) {
					continue;
				}
				try {
					execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
						cwd: fixturePath,
						stdio: 'pipe',
					});
				} catch {
					// The temp fixture is deleted below, which also removes its worktree bookkeeping.
				}
			}
		}
		if (revealWorktreeParent) {
			fs.rmSync(revealWorktreeParent, { recursive: true, force: true });
		}
		// Self-cleaning: remove the tmp fixture no matter how the run ended.
		if (fixturePath) {
			try {
				fs.rmSync(fixturePath, { recursive: true, force: true });
			} catch {
				// tmp dir — the OS will reap it eventually; never fail the run over cleanup
			}
		}
		if (auxiliaryPath) {
			fs.rmSync(auxiliaryPath, { recursive: true, force: true });
		}
		if (workspaceFilePath) {
			fs.rmSync(workspaceFilePath, { force: true });
		}
	}
}

main();
