import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(scriptDirectory, '..');
const driverSourcePath = path.join(scriptDirectory, 'scm-state-test-driver.cjs');
const expectedOutcome = process.argv.includes('--expect-reset') ? 'reset' : 'preserved';
const vscodeExecutablePath = process.env.BGV_VSCODE_EXECUTABLE_PATH
  ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

if (!fs.existsSync(vscodeExecutablePath)) {
  throw new Error(`VS Code executable not found: ${vscodeExecutablePath}`);
}

// VS Code places its instance IPC socket under --user-data-dir. macOS caps Unix-domain socket
// paths at 103 characters, while os.tmpdir() expands to a long /var/folders/... path, so keep this
// deliberately short or the isolated host fails before the test runner can start.
const testRoot = fs.mkdtempSync('/tmp/bgv-scm-');
const mainRepositoryPath = path.join(testRoot, 'main-repository');
const linkedWorktreePath = path.join(testRoot, 'linked-worktree');
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
  git(mainRepositoryPath, 'worktree', 'add', '--quiet', '-b', 'state-test-linked', linkedWorktreePath, 'HEAD');

  // Give the main repository both Staged Changes and Changes, and the linked worktree a Changes
  // group, without inventing fixture contents or depending on shell redirection.
  git(mainRepositoryPath, 'rm', '--quiet', 'LICENSE');
  git(mainRepositoryPath, 'mv', 'CONTRIBUTING.md', 'CONTRIBUTING-state-test.md');
  git(mainRepositoryPath, 'restore', '--staged', 'CONTRIBUTING.md', 'CONTRIBUTING-state-test.md');
  git(linkedWorktreePath, 'rm', '--quiet', 'LICENSE');
  git(linkedWorktreePath, 'mv', 'README.md', 'README-state-test.md');
  git(linkedWorktreePath, 'restore', '--staged', 'README.md', 'README-state-test.md');

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
    folders: [
      { name: 'SCM state linked worktree', path: linkedWorktreePath },
      { name: 'SCM state main', path: mainRepositoryPath },
    ],
    settings: {
      'git.openRepositoryInParentFolders': 'never',
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'better-git-vscode.collapseWorktreesOnStartup': expectedOutcome === 'reset',
    },
  }, null, 2));
}

async function runPhase(phase) {
  const resultFile = path.join(testRoot, `${phase}-result.json`);
  fs.rmSync(resultFile, { force: true });
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
        BGV_SCM_STATE_TEST_RESULT_FILE: resultFile,
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
      // The driver writes its result immediately before closing the isolated window. Give VS Code's
      // onWillSaveState/storage flush time to finish, then stop the otherwise-headless main process
      // that Electron can leave alive after its last window and extension host have exited.
      settleTimer = setTimeout(() => child.kill('SIGTERM'), 2000);
    }, 100);
    const timeout = setTimeout(() => {
      clearInterval(resultPoll);
      child.kill('SIGTERM');
      reject(new Error(`VS Code ${phase} phase did not exit within 30 seconds`));
    }, 30000);
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
  });

  assert.ok(fs.existsSync(resultFile), `${phase} driver did not write a result file`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, true, `${phase} driver failed: ${result.error ?? 'unknown error'}`);
  console.log(`[scm-state-test] ${phase} repository order=${JSON.stringify(result.repositoryRoots)}`);
  return result;
}

function findWorkspaceDatabase() {
  const workspaceStoragePath = path.join(userDataPath, 'User', 'workspaceStorage');
  const workspaceUri = pathToFileURL(workspacePath).toString();
  for (const entry of fs.readdirSync(workspaceStoragePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const metadataName of ['workspace.json', 'meta.json']) {
      const metadataPath = path.join(workspaceStoragePath, entry.name, metadataName);
      if (!fs.existsSync(metadataPath)) {
        continue;
      }
      const metadata = fs.readFileSync(metadataPath, 'utf8');
      const databasePath = path.join(workspaceStoragePath, entry.name, 'state.vscdb');
      if ((metadata.includes(workspaceUri) || metadata.includes(workspacePath)) && fs.existsSync(databasePath)) {
        return databasePath;
      }
    }
  }
  throw new Error(`Could not find workspace state database for ${workspacePath}`);
}

function readViewState(databasePath) {
  const value = execFileSync(
    'sqlite3',
    ['-readonly', databasePath, "select value from ItemTable where key='scm.viewState2';"],
    { encoding: 'utf8' }
  ).trim();
  assert.ok(value, 'VS Code did not persist scm.viewState2');
  const viewState = JSON.parse(value);
  assert.ok(Array.isArray(viewState.expanded), 'scm.viewState2.expanded must be an array');
  assert.ok(Array.isArray(viewState.focus), 'scm.viewState2.focus must be an array');
  assert.ok(Array.isArray(viewState.selection), 'scm.viewState2.selection must be an array');
  return viewState;
}

function writeViewState(databasePath, viewState) {
  const value = JSON.stringify(viewState).replaceAll("'", "''");
  execFileSync(
    'sqlite3',
    [databasePath, `update ItemTable set value='${value}' where key='scm.viewState2';`],
    { stdio: 'pipe' }
  );
}

function seedMixedViewState(databasePath, seededPhase) {
  const linkedProvider = seededPhase.repositoryProviders.find(
    provider => provider.root === linkedWorktreePath
  );
  const mainProvider = seededPhase.repositoryProviders.find(
    provider => provider.root === mainRepositoryPath
  );
  assert.ok(linkedProvider, `linked provider missing: ${JSON.stringify(seededPhase.repositoryProviders)}`);
  assert.ok(mainProvider, `main provider missing: ${JSON.stringify(seededPhase.repositoryProviders)}`);

  const seededViewState = {
    ...readViewState(databasePath),
    focus: [],
    selection: [],
    expanded: [
      `repo:${linkedProvider.providerId}`,
      `resourceGroup:${linkedProvider.providerId}/index`,
      `resourceGroup:${mainProvider.providerId}/index`,
      `resourceGroup:${mainProvider.providerId}/workingTree`,
    ],
  };
  writeViewState(databasePath, seededViewState);
  return readViewState(databasePath);
}

function assertSeededMixedState(viewState, seededPhase) {
  const linkedProvider = seededPhase.repositoryProviders.find(
    provider => provider.root === linkedWorktreePath
  );
  assert.ok(linkedProvider, `linked worktree missing from provider map: ${JSON.stringify(seededPhase.repositoryProviders)}`);
  const linkedProviderId = linkedProvider.providerId;
  const expanded = [...viewState.expanded].sort();
  assert.ok(
    expanded.includes(`repo:${linkedProviderId}`),
    `seed did not expand the linked repository: ${JSON.stringify(expanded)}`
  );
  assert.ok(
    expanded.includes(`resourceGroup:${linkedProviderId}/index`),
    `seed did not leave the linked Staged Changes group expanded: ${JSON.stringify(expanded)}`
  );
  assert.ok(
    !expanded.includes(`resourceGroup:${linkedProviderId}/workingTree`),
    `seed did not leave the linked Changes group collapsed: ${JSON.stringify(expanded)}`
  );
  assert.equal(
    expanded.filter(id => id.startsWith('repo:')).length,
    1,
    `seed must leave exactly one of the two repositories expanded: ${JSON.stringify(expanded)}`
  );
  return linkedProviderId;
}

let testFailed = false;
try {
  createFixture();
  console.log(`[scm-state-test] fixture=${testRoot}`);
  console.log(`[scm-state-test] expected=${expectedOutcome}`);

  const seededPhase = await runPhase('seed');
  const databasePath = findWorkspaceDatabase();
  const seededViewState = seedMixedViewState(databasePath, seededPhase);
  const linkedProviderId = assertSeededMixedState(seededViewState, seededPhase);
  const seededExpanded = [...seededViewState.expanded].sort();
  console.log(`[scm-state-test] seeded expanded=${JSON.stringify(seededExpanded)}`);

  const restoredPhase = await runPhase('verify');
  if (JSON.stringify(seededPhase.repositoryRoots) !== JSON.stringify(restoredPhase.repositoryRoots)) {
    console.log('[scm-state-test] repository discovery order changed across launches');
  }
  const restoredExpanded = [...readViewState(databasePath).expanded].sort();
  console.log(`[scm-state-test] restored expanded=${JSON.stringify(restoredExpanded)}`);

  if (expectedOutcome === 'preserved') {
    assert.deepEqual(restoredExpanded, seededExpanded, 'SCM expansion state changed across restart');
    console.log('BETTER_GIT_SCM_STATE_PRESERVED');
  } else {
    assert.notDeepEqual(restoredExpanded, seededExpanded, 'expected the current startup collapse to reset SCM state');
    assert.ok(
      !restoredExpanded.includes(`repo:${linkedProviderId}`),
      'linked repository unexpectedly remained expanded'
    );
    console.log('BETTER_GIT_SCM_STATE_RESET_REPRODUCED');
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
    try {
      git(mainRepositoryPath, 'worktree', 'remove', '--force', linkedWorktreePath);
    } catch {
      // The test root is removed below; do not hide an otherwise successful persistence result.
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}
