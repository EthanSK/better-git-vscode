import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Check before builds, fixture creation or VS Code launch. The Mini supports
// the existing direct workflow. A fallback Mac must run the Fleet job's own
// source so an ordinary command on the working MacBook still fails closed.
export function assertE2EHost() {
    if (process.platform !== "darwin") { return; }
    if (isFleetJobSource()) { return; }
    const hardware = JSON.parse(execFileSync("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"], {
        encoding: "utf8", timeout: 10_000,
    }));
    const model = hardware.SPHardwareDataType?.[0]?.machine_name;
    if (model !== "Mac mini") {
        throw new Error("Run Better Git E2Es on the Mini or in a managed Fleet desktop job. Local MacBook E2Es are disabled.");
    }
}

function isFleetJobSource() {
    const { FLEET_RUNNER, FLEET_RUNNER_JOB_ID: jobId, FLEET_RUNNER_JOB_DIR: jobDir } = process.env;
    if (FLEET_RUNNER !== "1" || !jobId || !jobDir || !isAbsolute(jobDir) || basename(jobDir) !== jobId) {
        return false;
    }
    const source = dirname(dirname(fileURLToPath(import.meta.url)));
    return source === join(jobDir, "src") && lstatSync(join(jobDir, ".fleet-job"), { throwIfNoEntry: false })?.isFile() === true;
}
