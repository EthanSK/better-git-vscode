# Better Git VS Code agent instructions

Read `LEARNINGS.md` before changing behavior, packaging, or release handling. Preserve new durable evidence there after a verified feature, fix, release, or investigation.

## Marketplace release gate

- Unless Ethan explicitly opts out, finish every Marketplace-bound feature, fix, or maintenance change through publication and verification.
- `vsce publish` success means **uploaded**, not **released**. A direct version-specific package download, valid archive, or matching hash also does not prove VS Code can see the version.
- Never tell Ethan a version is released, complete, live, available in VS Code, or ready to update until the command below exits zero and prints `BETTER_GIT_MARKETPLACE_RELEASE_VERIFIED` for the exact expected version:

  ```sh
  pat="$(security find-generic-password -w -s vsce-pat-ethansk -a EthanSK)"
  VSCE_PAT="$pat" node scripts/verify-marketplace-release.mjs \
    --vsix /absolute/path/to/better-git-vscode-X.Y.Z.vsix
  unset pat
  ```

- On Ethan's Mac, load the PAT from Keychain service `vsce-pat-ethansk`, account `EthanSK`, without printing it. Never commit, log, or echo the token.
- The verifier must check both authenticated publisher validation and the public validated-only Gallery result used by VS Code, then download and byte-compare the exact VSIX. Do not replace it with a weaker ad hoc check.
- While the verifier is waiting, report the state precisely as `uploaded; Marketplace validation pending` and keep waiting. Do not ask Ethan to refresh VS Code before the verifier succeeds.
- If the verifier times out or reports a validation message, the release is not complete. Retrieve the Marketplace verification log, repair the actual problem, publish a new version when necessary, and run the gate again.

## Local updates after release

- After making and verifying Better Git changes, update Ethan's local Better Git VS Code without breaking its Marketplace connection. This is the standing default requested on 2026-09-15 and replaces the previous user-managed-install policy; do not ask again for routine installation permission.
- Publish and pass the exact Marketplace release gate first, then use `code --install-extension ethansk.better-git-vscode --force` against Ethan's existing VS Code installation/profile. Use the Marketplace identifier without an `@version` suffix; do not sideload a local VSIX, uninstall first, or update unrelated extensions as part of the normal release workflow.
- Check the existing installed version first. If the verified release is already installed and correctly associated, do not reinstall it. Do not downgrade a newer installed release. Verify the resulting version and bundle against its release evidence, `metadata.source=gallery`, the Marketplace UUID, no version pin, and effective per-extension automatic updates. Never repair association by manually editing VS Code's extension metadata.
- Preserve unsaved files, terminals, running jobs and current work. Activate an update when necessary and safe, using the least disruptive supported extension restart; follow the heads-up workflow before a disruptive restart. Distinguish installed files from the version loaded by the extension host. If live work makes activation unsafe, report that exact pending step instead of claiming the new behavior is running. This does not authorize MacBook E2Es or Extension Development Hosts.
