# Contributing to Agentic Git

Agentic Git is a TypeScript VS Code extension bundled with webpack. Changes to review navigation should start with the behavior contract in [`docs/navigation-behavior.md`](docs/navigation-behavior.md) and the incident evidence in [`LEARNINGS.md`](LEARNINGS.md).

## Local setup

Requirements: Node.js 18 or newer, Git, and VS Code.

```sh
npm ci
npm run compile
```

Use VS Code's **Run Extension** launch configuration or press `F5` to open an isolated Extension Development Host. Development and release checks must not install, uninstall, reload, or restart the extension in the developer's normal VS Code profile.

## Validation

Run the complete validation path before submitting a behavior change:

```sh
npm test
```

`npm test` compiles the extension and tests, runs ESLint, then launches the real Extension Development Host suite. The suite builds temporary Git repositories and exercises the extension through VS Code's actual Git and editor APIs.

To reuse an existing VS Code executable instead of downloading another test build:

```sh
AGENTIC_GIT_VSCODE_EXECUTABLE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Electron" npm test
```

Also validate the production package before release:

```sh
npm run package
npx @vscode/vsce package
```

Inspect the resulting VSIX manifest and file tree. It must identify `EthanSK.agentic-git`, contain the production bundle and documentation, and exclude development output or credentials.

## Navigation changes

New-file stepping and tall-hunk stepping share one caret-owned boundary contract. In particular:

- every move begins at the current caret;
- a partial final step must land on and present the exact edge;
- rollover happens only on a later press;
- reversing direction continues from the current position; and
- rapid input remains serialized against the exact editor being presented.

Add an isolated-host regression for every edge case you change. Unit-only geometry checks are not enough for word wrap, sticky scroll, Source Control focus, diff rendering, or cross-file transitions.

## Project memory

After a verified feature, fix, deployment, or investigation, add durable evidence to [`LEARNINGS.md`](LEARNINGS.md). Record the visible symptom, actual root cause, implemented fix, and regression guard. Do not record guesses, secrets, or transient machine state.
