import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('ships and registers the complete Better Git VS Code identity and namespace', async () => {
		const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
		assert.ok(extension, 'Better Git VS Code extension manifest was not loaded by the extension test host');
		const manifest = extension.packageJSON;

		assert.strictEqual(manifest.name, 'better-git-vscode');
		assert.strictEqual(manifest.displayName, 'Better Git VS Code');
		assert.strictEqual(manifest.description, 'Fast, keyboard-driven Git review for the agentic age.');
		assert.strictEqual(manifest.repository?.url, 'https://github.com/EthanSK/better-git-vscode');

		const commandIds = (manifest.contributes?.commands as Array<{ command: string }>).map(item => item.command);
		assert.ok(commandIds.length > 0, 'Better Git VS Code must contribute commands');
		assert.ok(commandIds.every(id => id.startsWith('better-git-vscode.')), 'every contributed command must use better-git-vscode.*');
		assert.ok(!JSON.stringify(manifest).includes('agentic-git'), 'the extension manifest must not contain the retired agentic-git identifier');

		await extension.activate();
		const registeredCommands = new Set(await vscode.commands.getCommands(true));
		const missingRegistrations = commandIds.filter(id => !registeredCommands.has(id));
		assert.deepStrictEqual(
			missingRegistrations,
			[],
			`every contributed Better Git VS Code command must be registered at runtime; missing: ${missingRegistrations.join(', ')}`
		);

		const settingIds = Object.keys(manifest.contributes?.configuration?.properties ?? {});
		assert.ok(settingIds.length > 0, 'Better Git VS Code must contribute settings');
		assert.ok(settingIds.every(id => id.startsWith('better-git-vscode.')), 'every contributed setting must use better-git-vscode.*');
	});

	test('stage-and-advance editor-title button stays pinned to the far right', () => {
		const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
		assert.ok(extension, 'Better Git VS Code extension manifest was not loaded by the extension test host');

		const editorTitleContributions = extension.packageJSON.contributes?.menus?.['editor/title'] as
			| Array<{ command?: string; group?: string }>
			| undefined;
		const stageAndAdvanceContribution = editorTitleContributions?.find(
			contribution => contribution.command === 'better-git-vscode.stage-current-file-and-advance'
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
		const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
		assert.ok(extension, 'Better Git VS Code extension manifest was not loaded by the extension test host');
		const setting = extension.packageJSON.contributes?.configuration?.properties?.[
			'better-git-vscode.autoAddWorktreeOnReveal'
		];
		assert.ok(setting, 'autoAddWorktreeOnReveal setting is missing from package.json');
		assert.strictEqual(setting.default, true, 'autoAddWorktreeOnReveal must remain on by default');
	});

	test('experimental SCM tree-state management is fully off by default', () => {
		const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
		assert.ok(extension, 'Better Git VS Code extension manifest was not loaded by the extension test host');
		const experimentalSetting = extension.packageJSON.contributes?.configuration?.properties?.[
			'better-git-vscode.experimentalScmTreeStateManagement'
		];
		assert.ok(experimentalSetting, 'experimentalScmTreeStateManagement setting is missing from package.json');
		assert.strictEqual(
			experimentalSetting.default,
			false,
			'Better Git must leave the entire SCM tree-state subsystem off by default'
		);
		assert.ok(
			String(experimentalSetting.description).includes('Exact mixed-state restoration is paused'),
			'the experimental setting must not claim that broken exact restoration is available'
		);

		const collapseSetting = extension.packageJSON.contributes?.configuration?.properties?.[
			'better-git-vscode.collapseWorktreesOnStartup'
		];
		assert.ok(collapseSetting, 'collapseWorktreesOnStartup setting is missing from package.json');
		assert.strictEqual(collapseSetting.default, false, 'force-collapse must remain off inside the experiment');
		assert.ok(
			String(collapseSetting.description).includes('exactly once'),
			'startup collapse must be documented as a one-shot operation'
		);

		const collapseCommand = (extension.packageJSON.contributes?.commands as Array<{
			command: string;
			enablement?: string;
		}>).find(command => command.command === 'better-git-vscode.collapse-worktrees');
		assert.ok(collapseCommand, 'collapse-worktrees command contribution is missing');
		assert.strictEqual(
			collapseCommand.enablement,
			'config.better-git-vscode.experimentalScmTreeStateManagement',
			'manual SCM tree mutation must be disabled with the experiment'
		);
	});
});
