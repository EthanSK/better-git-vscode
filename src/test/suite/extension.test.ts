import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('ships the complete Agentic Git identity and namespace', () => {
		const extension = vscode.extensions.getExtension('EthanSK.agentic-git');
		assert.ok(extension, 'Agentic Git extension manifest was not loaded by the extension test host');
		const manifest = extension.packageJSON;

		assert.strictEqual(manifest.name, 'agentic-git');
		assert.strictEqual(manifest.displayName, 'Agentic Git');
		assert.strictEqual(manifest.description, 'Fast, keyboard-driven Git review for the agentic age.');
		assert.strictEqual(manifest.repository?.url, 'https://github.com/EthanSK/agentic-git');

		const commandIds = (manifest.contributes?.commands as Array<{ command: string }>).map(item => item.command);
		assert.ok(commandIds.length > 0, 'Agentic Git must contribute commands');
		assert.ok(commandIds.every(id => id.startsWith('agentic-git.')), 'every contributed command must use agentic-git.*');

		const settingIds = Object.keys(manifest.contributes?.configuration?.properties ?? {});
		assert.ok(settingIds.length > 0, 'Agentic Git must contribute settings');
		assert.ok(settingIds.every(id => id.startsWith('agentic-git.')), 'every contributed setting must use agentic-git.*');
	});

	test('stage-and-advance editor-title button stays pinned to the far right', () => {
		const extension = vscode.extensions.getExtension('EthanSK.agentic-git');
		assert.ok(extension, 'Agentic Git extension manifest was not loaded by the extension test host');

		const editorTitleContributions = extension.packageJSON.contributes?.menus?.['editor/title'] as
			| Array<{ command?: string; group?: string }>
			| undefined;
		const stageAndAdvanceContribution = editorTitleContributions?.find(
			contribution => contribution.command === 'agentic-git.stage-current-file-and-advance'
		);
		assert.ok(stageAndAdvanceContribution, 'Stage-and-advance editor/title contribution is missing from package.json');

		/*
		 * REGRESSION PIN: VS Code sorts the right-aligned editor-title navigation group in ascending order,
		 * so navigation@100 places the + at the stable far-right hover spot, RIGHT of the built-in diff
		 * Previous/Next Change arrows at orders 10/11. v1.2.19 changed this to navigation@9, swapped the +
		 * to the other side of those arrows, and caused the user-reported "inverse buttons" regression fixed
		 * in v1.2.21. If a future change intentionally moves this button, the developer must consciously
		 * update this pin test AND get user sign-off on the new position rather than silently breaking the
		 * established hover-position muscle memory again.
		 */
		assert.strictEqual(stageAndAdvanceContribution.group, 'navigation@100');
	});

	test('auto-add worktree on reveal defaults to enabled', () => {
		const extension = vscode.extensions.getExtension('EthanSK.agentic-git');
		assert.ok(extension, 'Agentic Git extension manifest was not loaded by the extension test host');
		const setting = extension.packageJSON.contributes?.configuration?.properties?.[
			'agentic-git.autoAddWorktreeOnReveal'
		];
		assert.ok(setting, 'autoAddWorktreeOnReveal setting is missing from package.json');
		assert.strictEqual(setting.default, true, 'autoAddWorktreeOnReveal must remain on by default');
	});

	test('repository sections collapse after startup/restart by default', () => {
		const extension = vscode.extensions.getExtension('EthanSK.agentic-git');
		assert.ok(extension, 'Agentic Git extension manifest was not loaded by the extension test host');
		const setting = extension.packageJSON.contributes?.configuration?.properties?.[
			'agentic-git.collapseWorktreesOnStartup'
		];
		assert.ok(setting, 'collapseWorktreesOnStartup setting is missing from package.json');
		assert.strictEqual(setting.default, true, 'restart collapse must remain enabled by default');
	});
});
