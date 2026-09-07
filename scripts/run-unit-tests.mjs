import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Mocha from "mocha";

// Use Mocha directly: its legacy CLI dependency cannot load on Node 26.
// These suites use real Git but never import VS Code or launch a GUI host.
const suites = new URL("../out/test/suite/", import.meta.url);
const files = (await readdir(suites))
    .filter((file) => /^(git|stageTransaction).*\.test\.js$/.test(file))
    .sort();
if (files.length === 0) { throw new Error("No compiled unit test suites found."); }
const mocha = new Mocha({ ui: "tdd", timeout: 10_000 });
for (const file of files) { mocha.addFile(fileURLToPath(new URL(file, suites))); }
mocha.run((failures) => { process.exitCode = failures ? 1 : 0; });
