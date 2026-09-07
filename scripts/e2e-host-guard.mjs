import { execFileSync } from "node:child_process";

// Check before builds, fixture creation, or VS Code launch. No override on a MacBook:
// the developer's interactive VS Code shares its CPU/GPU with the isolated host.
export function assertE2EHost() {
    if (process.platform !== "darwin") { return; }
    const hardware = JSON.parse(execFileSync("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"], {
        encoding: "utf8", timeout: 10_000,
    }));
    const model = hardware.SPHardwareDataType?.[0]?.machine_name;
    if (model !== "Mac mini") {
        throw new Error("Run Better Git E2Es on the Mac Mini through Agent Bridge. Local MacBook E2Es are disabled.");
    }
}
