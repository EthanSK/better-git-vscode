import * as assert from "assert";
import * as vscode from "vscode";
import { CommitMessageGenerator } from "../../codexCommitMessage";

suite("Commit message fallback", () => {
    const context = { scope: "staged", content: "EXACT_STAGED_CONTEXT", truncated: false };
    const primary = { provider: "codex", displayName: "Codex", executable: "codex" };
    const create = () => {
        const generator = Object.create(CommitMessageGenerator.prototype) as any;
        generator.output = { appendLine: () => undefined };
        generator.disposed = false;
        generator.findExecutable = async () => "claude";
        return generator;
    };
    test("success does not call Claude and failure uses the same captured diff exactly once", async () => {
        const generator = create();
        const calls: string[] = [];
        let fail = false;
        generator.generate = async (execution: any, supplied: unknown) => {
            assert.strictEqual(supplied, context);
            calls.push(execution.provider);
            if (fail && execution.provider === "codex") { throw new Error("unsupported model"); }
            return "Fix issue";
        };
        const tokens = new vscode.CancellationTokenSource();
        try {
            assert.strictEqual(await generator.generateWithFallback(primary, context, tokens.token, () => undefined), "Fix issue");
            assert.deepStrictEqual(calls, ["codex"]);
            calls.length = 0; fail = true;
            await generator.generateWithFallback(primary, context, tokens.token, () => undefined);
            assert.deepStrictEqual(calls, ["codex", "claude"]);
        } finally { tokens.dispose(); }
    });
    test("Cancel after a primary error prevents fallback", async () => {
        const generator = create(); const tokens = new vscode.CancellationTokenSource();
        const calls: string[] = [];
        generator.generate = async (execution: any) => { calls.push(execution.provider); tokens.cancel(); throw new Error("closed"); };
        try {
            await assert.rejects(generator.generateWithFallback(primary, context, tokens.token, () => undefined), vscode.CancellationError);
            assert.deepStrictEqual(calls, ["codex"]);
        } finally { tokens.dispose(); }
    });
    test("Cancel while finding the fallback prevents its process from starting", async () => {
        const generator = create(); const tokens = new vscode.CancellationTokenSource();
        let attempts = 0;
        generator.generate = async () => { attempts++; throw new Error("primary failure"); };
        generator.findExecutable = async () => { tokens.cancel(); return "claude"; };
        try {
            await assert.rejects(generator.generateWithFallback(primary, context, tokens.token, () => undefined), vscode.CancellationError);
            assert.strictEqual(attempts, 1);
        } finally { tokens.dispose(); }
    });
    test("both providers failing stops after two attempts; Claude-only never invokes Codex", async () => {
        const generator = create(); const tokens = new vscode.CancellationTokenSource(); const calls: string[] = [];
        generator.generate = async (execution: any) => { calls.push(execution.provider); throw new Error(`${execution.provider} failed`); };
        try {
            await assert.rejects(generator.generateWithFallback(primary, context, tokens.token, () => undefined), /claude failed/);
            assert.deepStrictEqual(calls, ["codex", "claude"]);
            calls.length = 0;
            await assert.rejects(generator.generateWithFallback({ ...primary, provider: "claude" }, context, tokens.token, () => undefined));
            assert.deepStrictEqual(calls, ["claude"]);
        } finally { tokens.dispose(); }
    });
    test("missing Claude preserves the primary failure; disposal never starts a fallback", async () => {
        const generator = create(); const tokens = new vscode.CancellationTokenSource();
        generator.generate = async () => { throw new Error("primary failure"); };
        generator.findExecutable = async () => undefined;
        try {
            await assert.rejects(generator.generateWithFallback(primary, context, tokens.token, () => undefined), /primary failure/);
            generator.disposed = true;
            generator.findExecutable = async () => { throw new Error("must not discover after disposal"); };
            await assert.rejects(generator.generateWithFallback(primary, context, tokens.token, () => undefined), vscode.CancellationError);
        } finally { tokens.dispose(); }
    });
});
