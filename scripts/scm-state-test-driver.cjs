const vscode = require('vscode');
const fs = require('node:fs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForRepositories(minimum, timeoutMs = 10000) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    throw new Error('Built-in vscode.git extension is unavailable');
  }

  const gitExports = await gitExtension.activate();
  const git = gitExports.getAPI(1);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (git.repositories.length >= minimum) {
      return git.repositories;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${minimum} repositories; found ${git.repositories.length}`);
}

async function runPhase() {
  const phase = process.env.BGV_SCM_STATE_TEST_PHASE;
  if (phase !== 'seed' && phase !== 'verify') {
    throw new Error(`Unexpected BGV_SCM_STATE_TEST_PHASE: ${phase}`);
  }

  const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
  if (!extension) {
    throw new Error('Better Git VS Code development extension was not loaded');
  }

  const betterGitApi = await extension.activate();
  await vscode.commands.executeCommand('workbench.view.scm');
  const repositories = await waitForRepositories(2);
  const autoCollapse = vscode.workspace
    .getConfiguration('better-git-vscode')
    .get('collapseWorktreesOnStartup');
  console.log(
    `[scm-state-test] phase=${phase} version=${extension.packageJSON.version} ` +
    `autoCollapse=${String(autoCollapse)} repositories=${repositories.length}`
  );

  if (phase === 'seed') {
    // Let the workbench finish creating the SCM tree and its workspace database. The parent
    // process writes the exact mixed `scm.viewState2` fixture after this isolated window exits;
    // that is deterministic and avoids pretending flaky focus commands are user interaction.
    await delay(1800);
  } else {
    // Better Git waits for VS Code's async SCM rebuild to settle, then restores repositories and
    // groups through the live tree. Keep this driver passive and await the production completion signal
    // instead of guessing how long cold repository discovery plus queued focus/tree commands will take.
    if (!autoCollapse && betterGitApi?.whenScmTreeStateSettled) {
      const outcome = await betterGitApi.whenScmTreeStateSettled;
      if (!outcome?.restored) {
        throw new Error(`Better Git did not restore SCM state: ${outcome?.reason ?? 'unknown reason'}`);
      }
      // Let VS Code's workbench storage debounce commit the final tree bits before closing the window.
      await delay(1500);
    } else {
      // The explicit legacy-collapse regression uses the separate asynchronous startup routine.
      await delay(15000);
    }
  }

  return {
    repositoryRoots: repositories.map(repository => repository.rootUri?.fsPath ?? null),
    repositoryProviders: (vscode.extensions.getExtension('vscode.git')?.exports?.model?.repositories ?? [])
      .map(repository => ({
        root: repository.root,
        providerId: `scm${repository.sourceControl.handle}`,
      })),
  };
}

exports.run = runPhase;

// When loaded as the tiny second development extension used by the persistence harness, drive the
// phase and close only that isolated window. A result file lets the parent distinguish a successful
// phase from an extension-host exception even though VS Code itself exits cleanly in both cases.
exports.activate = async function activate() {
  const resultFile = process.env.BGV_SCM_STATE_TEST_RESULT_FILE;
  let result = { ok: true };
  try {
    result = { ok: true, ...await runPhase() };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
    console.error('[scm-state-test] driver failed', error);
  }

  if (resultFile) {
    fs.writeFileSync(resultFile, JSON.stringify(result));
  }
  await delay(100);
  await vscode.commands.executeCommand('workbench.action.closeWindow');
};

exports.deactivate = function deactivate() {};
