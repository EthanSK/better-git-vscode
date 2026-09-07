import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertE2EHost } from "./e2e-host-guard.mjs";

assertE2EHost();
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const all = args.length === 1 && args[0] === "--all";
const grep = args.length === 2 && args[0] === "--grep" ? args[1] : undefined;
if (args.length && !all && !grep) {
    throw new Error("Usage: npm run test:e2e -- [--all | --grep <pattern>]");
}
const env = { ...process.env, BGV_TEST_ALL: all ? "1" : "0" };
if (grep) { env.BGV_TEST_GREP = grep; }
for (const command of [
    ["npm", ["run", "compile-tests"]],
    ["npm", ["run", "package"]],
    [process.execPath, ["out/test/runTest.js"]],
]) {
    const result = spawnSync(command[0], command[1], { cwd: root, env, stdio: "inherit" });
    if (result.error) { throw result.error; }
    if (result.status !== 0) { process.exit(result.status ?? 1); }
}
