# Contributing to Better Git VS Code

Better Git VS Code is a TypeScript VS Code extension bundled with webpack. Changes to review navigation should start with the behavior contract in [`docs/navigation-behavior.md`](docs/navigation-behavior.md) and the incident evidence in [`LEARNINGS.md`](LEARNINGS.md).

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
BGV_VSCODE_EXECUTABLE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm test
```

Changes that can affect Source Control repository/group expansion must also run the dedicated two-launch restart regression:

```sh
BGV_VSCODE_EXECUTABLE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm run test:scm-state
```

It uses one isolated profile across two Extension Development Host launches and proves that Better Git restores the same mixed repository/worktree and Changes-group expansion state. It never loads, reloads, installs, or updates the extension in the normal VS Code profile.

Also validate the production package before release:

```sh
npm run package
npx @vscode/vsce package
```

Inspect the resulting VSIX manifest and file tree. It must identify `EthanSK.better-git-vscode`, contain the production bundle and documentation, and exclude development output or credentials.

## Marketplace release verification

`vsce publish` confirms that Marketplace accepted an upload; it does not prove that Microsoft has validated the version or that VS Code can see it. After publishing, run the repository's hard release gate against the exact VSIX that was uploaded:

```sh
VSCE_PAT="$VSCE_PAT" node scripts/verify-marketplace-release.mjs \
  --vsix /absolute/path/to/better-git-vscode-X.Y.Z.vsix
```

The verifier waits for the authenticated publisher version to become `Validated`, independently requires the public validated-only Gallery query used by VS Code to return the same version, downloads the version-specific package, checks its identity and archive, and byte-compares it with the uploaded VSIX. A release is complete only when the command exits zero and prints `BETTER_GIT_MARKETPLACE_RELEASE_VERIFIED` for the expected version. Until then, describe the state as **uploaded; Marketplace validation pending**.

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
