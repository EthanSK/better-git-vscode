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
- Release work must not install, uninstall, update, reload, or restart Better Git VS Code in Ethan's normal VS Code. Ethan applies Marketplace updates himself.
