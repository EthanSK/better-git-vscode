import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(scriptDirectory, '..');
const placementScriptPath = path.join(scriptDirectory, 'place-vscode-window-on-macbook.swift');
const menuInspectorPath = path.join(scriptDirectory, 'inspect-vscode-context-menu.swift');
const vscodeExecutablePath = process.env.BGV_VSCODE_EXECUTABLE_PATH
  ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const commandTitle = 'Open index.html in System Browser';
const revealCommandTitle = 'Open & Reveal File in Explorer';
const copyWorktreeTitle = 'Copy Worktree Name';
const addWorktreeTitle = 'Add Worktree to Workspace';

if (process.platform !== 'darwin') {
  throw new Error('The native VS Code context-menu regression requires macOS');
}
if (!fs.existsSync(vscodeExecutablePath)) {
  throw new Error(`VS Code executable not found: ${vscodeExecutablePath}`);
}

const testRoot = fs.mkdtempSync('/tmp/bgv-index-menu-');
const repositoryPath = path.join(testRoot, 'independent-workspace');
const userDataPath = path.join(testRoot, 'user-data');
const extensionsPath = path.join(testRoot, 'extensions');
const linkedWorktreePath = path.join(testRoot, 'menu-linked-worktree');
const evidenceDirectory = process.env.BGV_INDEX_MENU_EVIDENCE_DIR ?? path.join(testRoot, 'evidence');
let testProcess;
let testFailed = false;

const git = (...args) => execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim();

function createFixture() {
  fs.mkdirSync(repositoryPath, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(extensionsPath, { recursive: true });
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(repositoryPath, 'index.html'),
    '<!doctype html>\n<html lang="en"><title>Better Git context-menu fixture</title><body>base</body></html>\n'
  );
  fs.writeFileSync(path.join(repositoryPath, 'notes.txt'), 'base\n');
  execFileSync('git', ['init', '-b', 'main', repositoryPath], { stdio: 'pipe' });
  git('config', 'user.email', 'index-context-menu-test@local.invalid');
  git('config', 'user.name', 'Better Git Index Context Menu Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-m', 'base');
  execFileSync('git', ['-C', repositoryPath, 'worktree', 'add', '--detach', linkedWorktreePath], { stdio: 'pipe' });
  fs.mkdirSync(path.join(userDataPath, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, 'User', 'settings.json'),
    JSON.stringify({ 'git.detectWorktrees': true })
  );
}

function cancelMenu(pid) {
  execFileSync('swift', [menuInspectorPath, 'cancel', String(pid)], { stdio: 'pipe', timeout: 10_000 });
}

function inspectMenu(pid, windowID, view, row, evidenceStem) {
  let probe;
  try {
    const output = execFileSync(
      'swift',
      [menuInspectorPath, 'show', String(pid), view, row],
      { encoding: 'utf8', timeout: 25_000 }
    ).trim();
    probe = JSON.parse(output.split('\n').at(-1));
    assert.equal(probe.pid, pid, `${view} menu came from the wrong process`);
    assert.equal(probe.windowID, windowID, `${view} menu came from the wrong VS Code window`);
    assert.match(
      probe.windowTitle,
      /^\[Extension Development Host\]/,
      `${view} menu did not come from an Extension Development Host`
    );
    assert.equal(probe.view, view);
    assert.equal(probe.row, row);
    assert.ok(probe.popupWindowID > 0, `${view} menu had no numeric native window id`);

    const windowScreenshotPath = path.join(evidenceDirectory, `${evidenceStem}-window-w${windowID}.png`);
    const menuScreenshotPath = path.join(
      evidenceDirectory,
      `${evidenceStem}-menu-w${probe.popupWindowID}.png`
    );
    execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(windowID), windowScreenshotPath]);
    execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(probe.popupWindowID), menuScreenshotPath]);
    assert.ok(fs.statSync(windowScreenshotPath).size > 1_000, `${view} window screenshot is empty`);
    assert.ok(fs.statSync(menuScreenshotPath).size > 1_000, `${view} menu screenshot is empty`);
    console.log(`[index-menu-test] ${view} row=${row} items=${JSON.stringify(probe.items)}`);
    console.log(`[index-menu-test] ${view} window screenshot=${windowScreenshotPath}`);
    console.log(`[index-menu-test] ${view} menu screenshot=${menuScreenshotPath}`);
    return probe;
  } finally {
    if (probe) {
      cancelMenu(pid);
    }
  }
}

function sourceControlRows(pid) {
  const output = execFileSync(
    'swift',
    [menuInspectorPath, 'list-rows', String(pid), 'source-control'],
    { encoding: 'utf8', timeout: 25_000 }
  ).trim();
  return JSON.parse(output.split('\n').at(-1));
}

async function waitForWorktreeRow(pid, timeoutMs = 20_000) {
  const worktreeName = path.basename(linkedWorktreePath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = sourceControlRows(pid);
    for (const row of rows) {
      for (const text of [row.title, row.description, row.value]) {
        if (text === worktreeName || text?.includes(worktreeName)) {
          console.log(`[index-menu-test] worktree row=${JSON.stringify(row)}`);
          return text;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Source Control worktree row: ${worktreeName}`);
}

async function stopTestProcess() {
  if (!testProcess || testProcess.exitCode !== null || testProcess.signalCode !== null) {
    return;
  }
  const closed = new Promise(resolve => testProcess.once('close', resolve));
  testProcess.kill('SIGTERM');
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 4_000))]);
  if (testProcess.exitCode === null && testProcess.signalCode === null) {
    testProcess.kill('SIGTERM');
  }
}

try {
  createFixture();
  console.log(`[index-menu-test] fixture=${testRoot}`);
  console.log(`[index-menu-test] version=${JSON.parse(fs.readFileSync(path.join(extensionDevelopmentPath, 'package.json'))).version}`);

  const args = [
    repositoryPath,
    `--user-data-dir=${userDataPath}`,
    `--extensions-dir=${extensionsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    '--new-window',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
  ];
  testProcess = spawn(vscodeExecutablePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  testProcess.stdout.on('data', chunk => process.stdout.write(chunk));
  testProcess.stderr.on('data', chunk => process.stderr.write(chunk));

  const placement = execFileSync(
    'swift',
    [placementScriptPath, String(testProcess.pid)],
    { encoding: 'utf8', timeout: 15_000 }
  ).trim();
  console.log(`[index-menu-test] MacBook placement\n${placement}`);
  assert.match(placement, /^display=Built-in Retina Display$/m);
  const windowID = Number(/^window=(\d+)$/m.exec(placement)?.[1]);
  assert.ok(windowID > 0, `placement did not report a numeric window id: ${placement}`);

  // Explorer's action must not depend on a Git change. Prove it before creating any fixture edits so the
  // visible test window and screenshot are clean by construction, with no Git-refresh race.
  assert.equal(git('status', '--porcelain'), '', 'Explorer menu fixture must be unchanged');
  const explorerProbe = inspectMenu(
    testProcess.pid,
    windowID,
    'explorer',
    'index.html',
    'index-context-explorer-clean'
  );
  assert.equal(explorerProbe.items[0], commandTitle, 'Explorer action must be first and visible');

  const nonIndexProbe = inspectMenu(
    testProcess.pid,
    windowID,
    'explorer',
    'notes.txt',
    'index-context-explorer-non-index'
  );
  assert.ok(
    !nonIndexProbe.items.includes(commandTitle),
    'Explorer action must stay hidden for non-index filenames'
  );

  fs.writeFileSync(
    path.join(repositoryPath, 'index.html'),
    '<!doctype html>\n<html lang="en"><title>Better Git context-menu fixture</title><body>changed</body></html>\n'
  );
  fs.writeFileSync(path.join(repositoryPath, 'notes.txt'), 'changed\n');
  assert.notEqual(git('status', '--porcelain'), '', 'Source Control menu fixture must contain changes');

  const scmProbe = inspectMenu(
    testProcess.pid,
    windowID,
    'source-control',
    'index.html, Modified',
    'index-context-source-control'
  );
  assert.equal(scmProbe.items[0], commandTitle, 'Source Control action must be first and visible');
  assert.ok(
    scmProbe.items.includes(revealCommandTitle),
    'Better Git reveal must be visible in the native Source Control file menu'
  );

  const worktreeRow = await waitForWorktreeRow(testProcess.pid);
  const worktreeProbe = inspectMenu(
    testProcess.pid,
    windowID,
    'source-control',
    worktreeRow,
    'worktree-context-source-control'
  );
  assert.deepEqual(
    worktreeProbe.items.slice(0, 2),
    [copyWorktreeTitle, addWorktreeTitle],
    'Copy and additive workspace actions must lead the native worktree-header menu'
  );

  console.log('BETTER_GIT_INDEX_CONTEXT_MENUS_VISIBLE');
  console.log('BETTER_GIT_WORKTREE_CONTEXT_MENUS_VISIBLE');
} catch (error) {
  testFailed = true;
  console.error(error);
  throw error;
} finally {
  await stopTestProcess();
  const keepFixture = process.env.BGV_KEEP_INDEX_MENU_TEST === '1';
  const evidenceOutsideFixture = path.resolve(evidenceDirectory) !== path.resolve(path.join(testRoot, 'evidence'));
  if (keepFixture || testFailed) {
    console.log(`[index-menu-test] kept fixture for inspection: ${testRoot}`);
  } else {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (evidenceOutsideFixture) {
      console.log(`[index-menu-test] preserved evidence: ${evidenceDirectory}`);
    }
  }
}
