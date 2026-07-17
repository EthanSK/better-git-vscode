const vscode = require('vscode');
const fs = require('node:fs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForRepositories(minimum, timeoutMs = 20000) {
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

async function waitForVerifiedMacBookPlacement(timeoutMs = 15000) {
  const placementFile = process.env.BGV_SCM_STATE_TEST_PLACEMENT_FILE;
  if (!placementFile) {
    throw new Error('BGV_SCM_STATE_TEST_PLACEMENT_FILE was not provided');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(placementFile)) {
      const placement = fs.readFileSync(placementFile, 'utf8');
      if (!placement.includes('display=Built-in Retina Display')) {
        throw new Error(`Unverified VS Code placement: ${placement}`);
      }
      console.log(`[scm-state-test] verified window placement: ${placement.replaceAll('\n', ' ')}`);
      return;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for verified MacBook VS Code window placement');
}

async function runPhase() {
  const phase = process.env.BGV_SCM_STATE_TEST_PHASE;
  const mode = process.env.BGV_SCM_STATE_TEST_MODE;
  const expectedRepositories = Number(process.env.BGV_SCM_STATE_TEST_EXPECTED_REPOSITORIES ?? '8');
  if (phase !== 'seed' && phase !== 'verify') {
    throw new Error(`Unexpected BGV_SCM_STATE_TEST_PHASE: ${phase}`);
  }
  if (!['disabled', 'enabled-inert', 'collapse'].includes(mode)) {
    throw new Error(`Unexpected BGV_SCM_STATE_TEST_MODE: ${mode}`);
  }

  // Do not reveal, focus, or otherwise operate the test window until the parent has identified the exact
  // isolated PID, moved only that process's window, and verified the numeric window ID on the MacBook display.
  await waitForVerifiedMacBookPlacement();

  const extension = vscode.extensions.getExtension('EthanSK.better-git-vscode');
  if (!extension) {
    throw new Error('Better Git VS Code development extension was not loaded');
  }

  const betterGitApi = await extension.activate();

  // This view command belongs to the test driver, not Better Git. It makes the eight-repository tree visible
  // for the exact-window screenshot while the extension trace independently proves what Better Git dispatched.
  await vscode.commands.executeCommand('workbench.view.scm');
  const repositories = await waitForRepositories(expectedRepositories);
  const experimentalTreeState = vscode.workspace
    .getConfiguration('better-git-vscode')
    .get('experimentalScmTreeStateManagement');
  const autoCollapse = vscode.workspace
    .getConfiguration('better-git-vscode')
    .get('collapseWorktreesOnStartup');
  console.log(
    `[scm-state-test] phase=${phase} mode=${mode} version=${extension.packageJSON.version} ` +
    `experimental=${String(experimentalTreeState)} autoCollapse=${String(autoCollapse)} ` +
    `repositories=${repositories.length}`
  );

  if (!betterGitApi?.whenScmTreeStateSettled) {
    throw new Error('Better Git did not expose the SCM tree-state completion promise');
  }
  const startupStartedAt = Date.now();
  const outcome = await betterGitApi.whenScmTreeStateSettled;

  if (mode === 'disabled') {
    if (outcome?.reason !== 'experimental Source Control tree-state management disabled') {
      throw new Error(`Unexpected disabled-mode outcome: ${JSON.stringify(outcome)}`);
    }
  } else if (mode === 'enabled-inert') {
    if (outcome?.reason !== 'automatic Source Control collapse disabled') {
      throw new Error(`Unexpected enabled-inert outcome: ${JSON.stringify(outcome)}`);
    }
  } else if (outcome?.changed !== true ||
      outcome?.reason !== 'collapsed once after discovery settled') {
    throw new Error(`Unexpected collapse-mode outcome: ${JSON.stringify(outcome)}`);
  }

  const traceAtSettlement = betterGitApi?.getScmTreeCommandTrace?.() ?? [];
  // Wait beyond the removed v1.2.30 restore delay and old recollapse interval. The trace must remain byte-for-byte
  // stable, proving there is no hidden timer or repository listener restarting the behavior after settlement.
  await delay(4500);
  const traceAfterWatchdog = betterGitApi?.getScmTreeCommandTrace?.() ?? [];

  return {
    repositoryRoots: repositories.map(repository => repository.rootUri?.fsPath ?? null),
    outcome,
    startupElapsedMs: Date.now() - startupStartedAt,
    traceAtSettlement,
    traceAfterWatchdog,
  };
}

exports.run = runPhase;

// When loaded as the tiny second development extension used by the harness, drive the phase and close only
// that isolated window. A result file lets the parent distinguish success from an extension-host exception.
exports.activate = async function activate() {
  const resultFile = process.env.BGV_SCM_STATE_TEST_RESULT_FILE;
  const closeFile = process.env.BGV_SCM_STATE_TEST_CLOSE_FILE;
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
  if (closeFile) {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(closeFile) && Date.now() < deadline) {
      await delay(100);
    }
  }
  await delay(100);
  await vscode.commands.executeCommand('workbench.action.closeWindow');
};

exports.deactivate = function deactivate() {};
