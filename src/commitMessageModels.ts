import { spawn } from "child_process";

export interface CommitModel {
    readonly id: string;
    readonly name: string;
    readonly effort?: string;
}

type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const versionCompare = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff) { return diff; }
    }
    return 0;
};

// Try the documented baseline when an older catalogue predates Luna. An account
// rejection follows the normal Claude fallback, never the CLI's flagship default.
export const codexBaseline: CommitModel = { id: "gpt-6-luna", name: "GPT-6 Luna", effort: "low" };

export function selectCodexCommitModel(values: readonly unknown[]): CommitModel {
    const candidates = values.flatMap(value => {
        const m = record(value);
        if (!m || m.hidden === true || typeof m.model !== "string") { return []; }
        const match = /^gpt-(\d+(?:\.\d+)*)(?:-codex)?-(luna|mini|nano)$/.exec(m.model);
        if (!match) { return []; }
        const version = match[1].split(".").map(Number);
        if (versionCompare(version, [6]) < 0) { return []; }
        const efforts = Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts.map((e: unknown) => record(e)?.reasoningEffort) : [];
        const effort = ["none", "minimal", "low", "medium"].find(e => efforts.includes(e));
        if (!effort) { return []; }
        return [{ version, size: ["nano", "mini", "luna"].indexOf(match[2]),
            model: { id: m.model, name: typeof m.displayName === "string" ? m.displayName : m.model, effort } }];
    });
    candidates.sort((a, b) => versionCompare(b.version, a.version) || a.size - b.size);
    return candidates[0]?.model ?? codexBaseline;
}

export function selectClaudeCommitModel(values: readonly unknown[]): CommitModel | undefined {
    const candidates = values.flatMap(value => {
        const m = record(value);
        if (!m || typeof m.value !== "string" || m.value === "default" || m.disabled === true) { return []; }
        // Older SDK catalogues have displayName but no resolvedModel. Never rank
        // default/best/opusplan or extended-context aliases as different models.
        const id = typeof m.resolvedModel === "string" ? m.resolvedModel : m.value;
        const canonical = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
        const display = /^(Haiku|Sonnet|Opus|Fable)\s+(\d+)(?:\.(\d+))?$/i.exec(m.displayName ?? "");
        const match = canonical ?? display;
        if (!match || /\[|plan/.test(m.value)) { return []; }
        const family = match[1].toLowerCase();
        const efforts = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [];
        const effort = m.supportsEffort === true ? ["low", "medium", "high"].find(e => efforts.includes(e)) ?? "low" : undefined;
        return [{ version: [Number(match[2]), Number(match[3] ?? 0)],
            size: ["haiku", "sonnet", "opus", "fable"].indexOf(family),
            model: { id: m.value, name: typeof m.displayName === "string" ? m.displayName : id, effort } }];
    });
    candidates.sort((a, b) => versionCompare(b.version, a.version) || a.size - b.size);
    return candidates[0]?.model;
}

/** A short-lived metadata handshake only: never starts a thread or sends a diff. */
export function discoverCommitModels(
    provider: "codex" | "claude", executable: string, cwd: string, signal: AbortSignal,
    timeoutMs = 15_000
): Promise<unknown[]> {
    if (signal.aborted) { return Promise.reject(new Error("Model discovery cancelled")); }
    return new Promise((resolve, reject) => {
        const args = provider === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json",
            "--output-format", "stream-json", "--verbose", "--tools", "", "--setting-sources", "",
            "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
        const child = spawn(executable, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: "pipe" });
        let settled = false;
        let buffer = "";
        let bytes = 0;
        let requestId = 2;
        const models: unknown[] = [];
        const cursors = new Set<string>();
        const finish = (error?: Error) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            child.stdin.end();
            child.kill();
            // An unresponsive CLI must not survive cancellation/disposal indefinitely.
            const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
            killTimer.unref();
            child.once("close", () => clearTimeout(killTimer));
            if (error) { reject(error); } else { resolve(models); }
        };
        const cancel = () => finish(new Error("Model discovery cancelled"));
        const timer = setTimeout(() => finish(new Error("Model discovery timed out")), timeoutMs);
        signal.addEventListener("abort", cancel, { once: true });
        const send = (value: unknown) => { if (!settled) { child.stdin.write(`${JSON.stringify(value)}\n`); } };
        child.on("error", () => finish(new Error("Model discovery could not start")));
        child.stdin.on("error", () => finish(new Error("Model discovery input closed")));
        child.on("close", () => finish(new Error("Model discovery ended before returning models")));
        child.stderr.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1_000_000) { finish(new Error("Model discovery output exceeded limit")); }
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 1_000_000) { finish(new Error("Model discovery output exceeded limit")); return; }
            buffer += chunk;
            let newline: number;
            while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                let message: RecordValue | undefined;
                try { message = record(JSON.parse(line)); } catch { continue; }
                if (!message) { continue; }
                if (provider === "claude") {
                    if (message.type !== "control_response" || message.response?.request_id !== "models") { continue; }
                    const data = message.response?.response?.models;
                    if (message.response?.subtype !== "success" || !Array.isArray(data)) {
                        finish(new Error("Claude model discovery failed")); return;
                    }
                    models.push(...data); finish();
                } else if (message.id === 1) {
                    if (message.error) { finish(new Error("Codex initialization failed")); return; }
                    send({ method: "initialized", params: {} });
                    send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false } });
                } else if (message.id === requestId) {
                    const data = message.result?.data;
                    if (message.error || !Array.isArray(data)) { finish(new Error("Codex model discovery failed")); return; }
                    models.push(...data);
                    const cursor = message.result.nextCursor;
                    if (cursor === null || cursor === undefined) { finish(); return; }
                    if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 9) {
                        finish(new Error("Codex model discovery pagination failed")); return;
                    }
                    cursors.add(cursor);
                    send({ id: ++requestId, method: "model/list", params: { limit: 100, includeHidden: false, cursor } });
                }
            }
        });
        send(provider === "codex"
            ? { id: 1, method: "initialize", params: { clientInfo: { name: "better_git_commit", version: "1.0" } } }
            : { type: "control_request", request_id: "models", request: { subtype: "initialize" } });
        if (signal.aborted) { cancel(); }
    });
}
