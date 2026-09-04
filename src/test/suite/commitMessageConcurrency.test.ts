import * as assert from "assert";
import * as vscode from "vscode";
import { CommitMessageGenerator } from "../../codexCommitMessage";

suite("Commit message concurrency", () => {
    test("reserves a repository before collecting the diff or choosing a provider", async () => {
        // Use the actual command implementation without registering its public
        // command twice in the running Extension Development Host.
        const generator = Object.create(CommitMessageGenerator.prototype) as any;
        generator.runningRepositoryPaths = new Set<string>();
        const repository = { rootUri: vscode.Uri.file("/tmp/better-git-ai-concurrency"), inputBox: { value: "" } };
        generator.resolveRepository = async () => repository;
        generator.resolveProviderExecution = async () => undefined;
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const contextStarted = new Promise<void>((resolve) => { started = resolve; });
        let contextReads = 0;
        generator.buildChangeContext = async () => {
            contextReads++;
            started();
            await gate;
            return { scope: "staged", content: "test change", truncated: false };
        };
        const first = generator.execute([]);
        await contextStarted;
        const second = generator.execute([]);
        try {
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(contextReads, 1, "A double click must not begin two generation workflows");
        } finally {
            release();
            await Promise.all([first, second]);
        }
        await generator.execute([]);
        assert.strictEqual(contextReads, 2, "Cancelling provider selection must release the repository reservation");
    });
});
