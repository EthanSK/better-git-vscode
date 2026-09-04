import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
	if (process.env.BGV_TEST_START_DELAY_MS) {
		await new Promise((resolve) => setTimeout(resolve, Number(process.env.BGV_TEST_START_DELAY_MS)));
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
