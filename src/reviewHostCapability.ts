// Advertise registered mouse-review commands to Agentic Mouse without polling or inspecting installed files.
// Each activation owns a unique receipt: an older dispose must never delete a newer same-PID activation.
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const executeFile = promisify(execFile);
export const ATOMIC_EYES_BEGIN_CAPABILITY = "atomic-default-eyes-begin-v1";
export interface ReviewHostCapability {
    schemaVersion: 1;
    extensionVersion: string;
    capabilities: readonly string[];
    activationId: string;
    hostPid: number;
    hostStartTime: string;
    codePid: number;
    codeStartTime: string;
}

export const parseProcessStartTimes = (output: string, expectedPids: readonly number[]): Map<number, string> => {
    const result = new Map<number, string>();
    for (const rawLine of output.trim().split("\n")) {
        const line = rawLine.trim().replace(/\s+/g, " ");
        const match = /^(\d+) ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.exec(line);
        if (!match) { throw new Error("Invalid process start-time response."); }
        const pid = Number(match[1]);
        if (!expectedPids.includes(pid) || result.has(pid)) { throw new Error("Unexpected process identity."); }
        result.set(pid, match[2]);
    }
    if (result.size !== new Set(expectedPids).size) { throw new Error("A process exited before capability publication."); }
    return result;
};

const readProcessStartTimes = async (hostPid: number, codePid: number): Promise<Map<number, string>> => {
    const { stdout } = await executeFile("/bin/ps", ["-p", `${hostPid},${codePid}`, "-o", "pid=,lstart="], {
        encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, maxBuffer: 16 * 1024, timeout: 2000,
    }); // One bounded background query per activation, never on a navigation/hold input path.
    return parseProcessStartTimes(stdout, [hostPid, codePid]);
};

export const createReviewHostCapability = (options: {
    directory: string; extensionVersion: string; codePid: string | undefined; log: (message: string) => void;
}): { ready: Promise<void>; dispose: () => Promise<void> } => {
    const hostPid = process.pid;
    const activationId = randomUUID();
    const receiptPath = path.join(options.directory, `${hostPid}-${activationId}.json`);
    const temporaryPath = `${receiptPath}.tmp`;
    let disposed = false;
    const report = (error: unknown): void => {
        try { options.log(`Review host capability unavailable: ${String(error)}`); } catch { /* Diagnostics cannot affect activation. */ }
    };
    const retire = async (): Promise<void> => {
        try {
            const stat = await fs.lstat(receiptPath);
            if (!stat.isFile() || stat.size > 4096) { return; }
            const receipt: unknown = JSON.parse(await fs.readFile(receiptPath, "utf8"));
            if (receipt && typeof receipt === "object" && "activationId" in receipt && receipt.activationId === activationId) {
                await fs.unlink(receiptPath);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") { report(error); }
        }
    };
    const pruneClosedReceipts = async (): Promise<void> => {
        // A killed host cannot run dispose. Bound crash leftovers without a timer, before they accumulate.
        // Signal zero only checks existence; it never stops a process. Unique activation paths ensure that
        // even PID reuse after this check cannot delete another activation's receipt.
        const names = (await fs.readdir(options.directory)).filter(name =>
            /^[1-9]\d{0,9}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(name)).slice(0, 128);
        for (const name of names) {
            if (disposed) { break; }
            const pid = Number(name.slice(0, name.indexOf("-")));
            if (pid === hostPid || pid > 0x7fffffff) { continue; }
            try { process.kill(pid, 0); continue; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { continue; } }
            const candidate = path.join(options.directory, name);
            try {
                const stat = await fs.lstat(candidate);
                if (!stat.isFile() || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid())) { continue; }
                const receipt: unknown = JSON.parse(await fs.readFile(candidate, "utf8"));
                if (receipt && typeof receipt === "object" && "schemaVersion" in receipt && receipt.schemaVersion === 1
                    && "hostPid" in receipt && receipt.hostPid === pid && "activationId" in receipt && typeof receipt.activationId === "string"
                    && `${pid}-${receipt.activationId}.json` === name && "capabilities" in receipt
                    && Array.isArray(receipt.capabilities) && receipt.capabilities.includes(ATOMIC_EYES_BEGIN_CAPABILITY)) {
                    await fs.unlink(candidate);
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { report(error); } }
        }
    };
    const ready = (async () => {
        if (!options.codePid || !/^[1-9]\d{0,9}$/.test(options.codePid)) { throw new Error("Missing Code process identity."); }
        const codePid = Number(options.codePid);
        if (codePid > 0x7fffffff || codePid === hostPid) { throw new Error("Invalid Code process identity."); }
        const starts = await readProcessStartTimes(hostPid, codePid);
        if (disposed) { return; }
        const hostStartTime = starts.get(hostPid), codeStartTime = starts.get(codePid);
        if (!hostStartTime || !codeStartTime) { throw new Error("Missing process start identity."); }
        const receipt: ReviewHostCapability = {
            schemaVersion: 1, extensionVersion: options.extensionVersion, capabilities: [ATOMIC_EYES_BEGIN_CAPABILITY],
            activationId, hostPid, hostStartTime, codePid, codeStartTime,
        };
        await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
        if (disposed) { return; }
        await fs.writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (!disposed) { await fs.rename(temporaryPath, receiptPath); }
        if (disposed) { await retire(); }
        else { await pruneClosedReceipts(); } // Publish first; cleanup never delays the consumer seeing readiness.
    })().catch(report).finally(async () => { await fs.rm(temporaryPath, { force: true }).catch(report); });
    return { ready, dispose: async () => { disposed = true; await ready; await retire(); } };
};
