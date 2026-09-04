import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
	if (process.env.BGV_TEST_START_DELAY_MS) {
		await new Promise((resolve) => setTimeout(resolve, Number(process.env.BGV_TEST_START_DELAY_MS)));
	}
	if (process.env.BGV_PLACE_ON_MACBOOK === '1') {
		const pid = process.env.VSCODE_PID;
		const workspace = vscode.workspace.workspaceFile;
		if (!pid || !/^\d+$/.test(pid) || !workspace) { throw new Error('Missing isolated test window identity'); }
		console.log(execFileSync('swift', [
			path.resolve(__dirname, '../../../scripts/place-vscode-window-on-macbook.swift'), pid,
			path.basename(workspace.fsPath, '.code-workspace'),
		], { encoding: 'utf8', timeout: 20000 })); // Move only this PID's exact fixture window before any test drives the UI.
	}
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		grep: process.env.BGV_TEST_GREP,
		color: true,
		// E2E tests drive a real VS Code window + real git subprocesses + the git extension's async state
		// refreshes — individual tests legitimately take multiple seconds. The default 2s mocha timeout
		// would flake constantly, so give each test a generous budget; the polling helpers inside the
		// tests keep the HAPPY path fast (they resolve as soon as the condition is met).
		timeout: 60_000
	});

	const testsRoot = path.resolve(__dirname, '..');
	const files = await glob('**/**.test.js', { cwd: testsRoot });

	// Add files to the test suite
	files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

	try {
		return new Promise<void>((c, e) => {
			// Run the mocha test
			mocha.run(failures => {
				if (failures > 0) {
					e(new Error(`${failures} tests failed.`));
				} else {
					c();
				}
			});
		});
	} catch (err) {
		console.error(err);
	}
}
