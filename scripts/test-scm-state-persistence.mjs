import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(scriptDirectory, '..');
const driverSourcePath = path.join(scriptDirectory, 'scm-state-test-driver.cjs');
const windowPlacementScriptPath = path.join(scriptDirectory, 'place-vscode-window-on-macbook.swift');
const screenshotHelperPath = '/Users/ethansarif-kattan/.codex/skills/screenshot/scripts/take_screenshot.py';
const expectedMode = process.argv.includes('--expect-disabled')
  ? 'disabled'
  : process.argv.includes('--expect-enabled-inert')
    ? 'enabled-inert'
    : process.argv.includes('--expect-collapse')
      ? 'collapse'
      : null;
const repositoryCount = 8;
const vscodeExecutablePath = process.env.BGV_VSCODE_EXECUTABLE_PATH
  ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

if (!expectedMode) {
  throw new Error(
    'Choose exactly one mode: --expect-disabled, --expect-enabled-inert, or --expect-collapse'
  );
}
if (!fs.existsSync(vscodeExecutablePath)) {
  throw new Error(`VS Code executable not found: ${vscodeExecutablePath}`);
}

// VS Code places its IPC socket under --user-data-dir. macOS caps Unix-domain socket paths at 103
// characters, so use a deliberately short fixture path instead of os.tmpdir()'s long /var/folders path.
const testRoot = fs.mkdtempSync('/tmp/bgv-scm-');
const evidenceDirectory = process.env.BGV_SCM_STATE_EVIDENCE_DIR ?? testRoot;
fs.mkdirSync(evidenceDirectory, { recursive: true });
const mainRepositoryPath = path.join(testRoot, 'main-repository');
const linkedWorktreePaths = Array.from(
  { length: repositoryCount - 1 },
  (_, index) => path.join(testRoot, `linked-worktree-${index + 1}`)
);
const repositoryPaths = [...linkedWorktreePaths, mainRepositoryPath];
const userDataPath = path.join(testRoot, 'user-data');
const extensionsPath = path.join(testRoot, 'extensions');
const workspacePath = path.join(testRoot, 'scm-state.code-workspace');
const driverExtensionPath = path.join(testRoot, 'scm-state-driver');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

function createFixture() {
  execFileSync('git', ['clone', '--quiet', '--no-local', extensionDevelopmentPath, mainRepositoryPath]);
  git(mainRepositoryPath, 'config', 'user.email', 'scm-state-test@local.invalid');
  git(mainRepositoryPath, 'config', 'user.name', 'Better Git SCM State Test');
  git(mainRepositoryPath, 'config', 'commit.gpgsign', 'false');

  for (const [index, worktreePath] of linkedWorktreePaths.entries()) {
    git(
      mainRepositoryPath,
      'worktree',
      'add',
      '--quiet',
      '-b',
      `state-test-linked-${index + 1}`,
      worktreePath,
      'HEAD'
    );
  }

  // The original two-repository fixture missed the production loop. Keep eight live repositories and give
  // every repository both Staged Changes and Changes groups so the screenshots expose accidental row walking.
  for (const [index, repositoryPath] of repositoryPaths.entries()) {
    git(repositoryPath, 'rm', '--quiet', 'LICENSE');
    const renamedReadme = `README-state-test-${index + 1}.md`;
    git(repositoryPath, 'mv', 'README.md', renamedReadme);
    git(repositoryPath, 'restore', '--staged', 'README.md', renamedReadme);
  }

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(extensionsPath, { recursive: true });
  fs.mkdirSync(driverExtensionPath, { recursive: true });
  fs.copyFileSync(driverSourcePath, path.join(driverExtensionPath, 'extension.cjs'));
  fs.writeFileSync(path.join(driverExtensionPath, 'package.json'), JSON.stringify({
    name: 'better-git-scm-state-test-driver',
    displayName: 'Better Git SCM State Test Driver',
    version: '0.0.0',
    publisher: 'better-git-tests',
    engines: { vscode: '^1.83.0' },
    activationEvents: ['onStartupFinished'],
    main: './extension.cjs',
  }, null, 2));
  fs.writeFileSync(workspacePath, JSON.stringify({
    folders: repositoryPaths.map((repositoryPath, index) => ({
      name: index === repositoryPaths.length - 1
        ? 'SCM state main'
        : `SCM state linked worktree ${index + 1}`,
      path: repositoryPath,
    })),
    settings: {
      'git.openRepositoryInParentFolders': 'never',
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'better-git-vscode.experimentalScmTreeStateManagement': expectedMode !== 'disabled',
      'better-git-vscode.collapseWorktreesOnStartup': expectedMode === 'collapse',
    },
  }, null, 2));
}

async function runPhase(phase) {
  const resultFile = path.join(testRoot, `${phase}-result.json`);
  const placementFile = path.join(testRoot, `${phase}-window-placement.txt`);
  const closeFile = path.join(testRoot, `${phase}-close-window`);
  fs.rmSync(resultFile, { force: true });
  fs.rmSync(placementFile, { force: true });
  fs.rmSync(closeFile, { force: true });

  const args = [
    workspacePath,
    `--user-data-dir=${userDataPath}`,
    `--extensions-dir=${extensionsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensionDevelopmentPath=${driverExtensionPath}`,
    '--new-window',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(vscodeExecutablePath, args, {
      env: {
        ...process.env,
        BGV_SCM_STATE_TEST_PHASE: phase,
        BGV_SCM_STATE_TEST_MODE: expectedMode,
        BGV_SCM_STATE_TEST_EXPECTED_REPOSITORIES: String(repositoryCount),
        BGV_SCM_STATE_TEST_RESULT_FILE: resultFile,
        BGV_SCM_STATE_TEST_PLACEMENT_FILE: placementFile,
        BGV_SCM_STATE_TEST_CLOSE_FILE: closeFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));

    let phaseReported = false;
    let settleTimer;
    const resultPoll = setInterval(() => {
      if (!fs.existsSync(resultFile)) {
        return;
      }
      phaseReported = true;
      clearInterval(resultPoll);
      try {
        const placement = fs.readFileSync(placementFile, 'utf8');
        const windowId = /^window=(\d+)$/m.exec(placement)?.[1];
        assert.ok(windowId, `missing numeric window id in placement proof: ${placement}`);
        const screenshotPath = path.join(
          evidenceDirectory,
          `scm-state-${expectedMode}-${phase}-w${windowId}.png`
        );
        const captureOutput = execFileSync(
          'python3',
          [screenshotHelperPath, '--window-id', windowId, '--path', screenshotPath],
          { encoding: 'utf8', timeout: 15000 }
        ).trim();
        console.log(`[scm-state-test] ${phase} screenshot=${captureOutput}`);
        fs.writeFileSync(closeFile, 'captured');
      } catch (error) {
        fs.writeFileSync(closeFile, 'capture-failed');
        child.kill('SIGTERM');
        reject(new Error(`Could not capture ${phase} VS Code window: ${String(error)}`));
        return;
      }
      // The driver now owns only the isolated window. Give its close/storage handshake time to finish, then
      // stop the otherwise-headless main process Electron can leave after the last isolated window exits.
      settleTimer = setTimeout(() => child.kill('SIGTERM'), 2000);
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(resultPoll);
      child.kill('SIGTERM');
      reject(new Error(`VS Code ${phase} phase did not exit within 60 seconds`));
    }, 60000);
    child.once('error', error => {
      clearTimeout(timeout);
      clearInterval(resultPoll);
      clearTimeout(settleTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearInterval(resultPoll);
      clearTimeout(settleTimer);
      const reportedBeforeClose = phaseReported || fs.existsSync(resultFile);
      if (reportedBeforeClose && (code === 0 || signal === 'SIGTERM')) {
        resolve();
      } else {
        reject(new Error(
          `VS Code ${phase} phase exited before reporting completion ` +
          `(code=${String(code)}, signal=${String(signal)})`
        ));
      }
    });

    try {
      const placement = execFileSync(
        'swift',
        [windowPlacementScriptPath, String(child.pid)],
        { encoding: 'utf8', timeout: 15000 }
      ).trim();
      console.log(`[scm-state-test] ${phase} MacBook placement\n${placement}`);
      fs.writeFileSync(placementFile, placement);
    } catch (error) {
      child.kill('SIGTERM');
      reject(new Error(`Could not place ${phase} VS Code window on the MacBook display: ${String(error)}`));
    }
  });

  assert.ok(fs.existsSync(resultFile), `${phase} driver did not write a result file`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, true, `${phase} driver failed: ${result.error ?? 'unknown error'}`);
  console.log(`[scm-state-test] ${phase} repository order=${JSON.stringify(result.repositoryRoots)}`);
  console.log(`[scm-state-test] ${phase} settled trace=${JSON.stringify(result.traceAtSettlement)}`);
  console.log(`[scm-state-test] ${phase} watchdog trace=${JSON.stringify(result.traceAfterWatchdog)}`);
  return result;
}

function assertPhase(result, phase) {
  assert.equal(result.repositoryRoots.length, repositoryCount, `${phase} did not discover all repositories`);
  assert.equal(
    new Set(result.repositoryRoots).size,
    repositoryCount,
    `${phase} repository roots were not distinct`
  );
  assert.deepEqual(
    result.traceAfterWatchdog,
    result.traceAtSettlement,
    `${phase} restarted SCM behavior after its completion promise settled`
  );

  if (expectedMode === 'disabled') {
    assert.deepEqual(result.traceAfterWatchdog, [], `${phase} disabled mode issued an SCM tree command`);
    assert.equal(
      result.outcome?.reason,
      'experimental Source Control tree-state management disabled'
    );
  } else if (expectedMode === 'enabled-inert') {
    assert.deepEqual(
      result.traceAfterWatchdog,
      [],
      `${phase} enabled master switch mutated SCM with startup collapse still off`
    );
    assert.equal(result.outcome?.reason, 'automatic Source Control collapse disabled');
  } else {
    assert.deepEqual(
      result.traceAfterWatchdog,
      ['workbench.view.scm', 'workbench.scm.action.collapseAllRepositories'],
      `${phase} collapse mode must reveal and collapse once with no retries or traversal`
    );
    assert.equal(result.outcome?.changed, true);
    assert.ok(
      result.startupElapsedMs < 20000,
      `${phase} one-shot collapse took too long: ${result.startupElapsedMs}ms`
    );
  }

  assert.ok(
    result.traceAfterWatchdog.every(command => !command.startsWith('list.')),
    `${phase} used a forbidden generic list command: ${JSON.stringify(result.traceAfterWatchdog)}`
  );
}

let testFailed = false;
try {
  createFixture();
  console.log(`[scm-state-test] fixture=${testRoot}`);
  console.log(`[scm-state-test] expected=${expectedMode}`);

  const productionSource = fs.readFileSync(path.join(extensionDevelopmentPath, 'src', 'extension.ts'), 'utf8');
  assert.ok(
    !/executeScmTreeCommand\(["']list\./.test(productionSource),
    'production code still dispatches a generic list command'
  );
  for (const removedRestorerSymbol of [
    'runRestoreScmTreeStateOnStartup',
    'startScmTreeStateCapture',
    'SCM_VIEW_STATE_STORAGE_KEY',
    'SCM_TREE_STATE_WORKSPACE_STATE_KEY',
  ]) {
    assert.ok(
      !productionSource.includes(removedRestorerSymbol),
      `production exact-restoration code still contains ${removedRestorerSymbol}`
    );
  }

  const firstPhase = await runPhase('seed');
  const restartedPhase = await runPhase('verify');
  assertPhase(firstPhase, 'first launch');
  assertPhase(restartedPhase, 'restart');

  if (expectedMode === 'disabled') {
    console.log('BETTER_GIT_SCM_STATE_DISABLED_INERT');
  } else if (expectedMode === 'enabled-inert') {
    console.log('BETTER_GIT_SCM_STATE_ENABLED_WITHOUT_COLLAPSE_INERT');
  } else {
    console.log('BETTER_GIT_SCM_COLLAPSE_ONCE_NO_ROW_WALK');
  }
} catch (error) {
  testFailed = true;
  console.error(error);
  throw error;
} finally {
  const keepFixture = process.env.BGV_KEEP_SCM_STATE_TEST === '1';
  if (keepFixture || testFailed) {
    console.log(`[scm-state-test] kept fixture for inspection: ${testRoot}`);
  } else {
    for (const linkedWorktreePath of linkedWorktreePaths) {
      try {
        git(mainRepositoryPath, 'worktree', 'remove', '--force', linkedWorktreePath);
      } catch {
        // The explicit /tmp fixture is removed below; do not hide an otherwise successful test result.
      }
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}
