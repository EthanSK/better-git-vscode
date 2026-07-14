import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('stage-and-advance editor-title button stays pinned to the far right', () => {
		const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
		assert.ok(extension, 'Better Git extension manifest was not loaded by the extension test host');

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
		assert.ok(extension, 'Better Git extension manifest was not loaded by the extension test host');
		const setting = extension.packageJSON.contributes?.configuration?.properties?.[
			'better-git-vscode.autoAddWorktreeOnReveal'
		];
		assert.ok(setting, 'autoAddWorktreeOnReveal setting is missing from package.json');
		assert.strictEqual(setting.default, true, 'autoAddWorktreeOnReveal must remain on by default');
	});

	test('Dvorak Option+>/< aliases always use canonical change navigation', () => {
		const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
		assert.ok(extension, 'Better Git extension manifest was not loaded by the extension test host');
		const keybindings = extension.packageJSON.contributes?.keybindings as
			| Array<{ command?: string; key?: string; mac?: string; when?: string }>
			| undefined;
		assert.ok(keybindings, 'Better Git keybindings are missing from package.json');

		const dvorakWhen = 'config.better-git-vscode.dvorakMode';
		const hasBinding = (command: string, key: string) =>
			keybindings.some(binding =>
				binding.command === command &&
				binding.key === key &&
				binding.mac === key &&
				binding.when === dvorakWhen
			);

		for (const key of ['alt+v', 'alt+.']) {
			assert.ok(hasBinding('better-git-vscode.next-scm-change', key), `Dvorak next alias ${key} is missing`);
		}
		for (const key of ['alt+w', 'alt+,']) {
			assert.ok(hasBinding('better-git-vscode.previous-scm-change', key), `Dvorak previous alias ${key} is missing`);
		}
		for (const key of ['shift+alt+v', 'shift+alt+.']) {
			assert.ok(hasBinding('better-git-vscode.stage-and-next-changed-file', key), `Dvorak stage-next alias ${key} is missing`);
		}
		for (const key of ['shift+alt+w', 'shift+alt+,']) {
			assert.ok(hasBinding('better-git-vscode.stage-and-previous-changed-file', key), `Dvorak stage-previous alias ${key} is missing`);
		}

		const smartKeyboardDefaults = keybindings.filter(binding =>
			binding.command === 'better-git-vscode.smart-forward' || binding.command === 'better-git-vscode.smart-back'
		);
		assert.deepStrictEqual(
			smartKeyboardDefaults,
			[],
			'smart mouse commands must not own keyboard defaults; their reversed review direction hijacks Option+>/< navigation'
		);
	});
});
