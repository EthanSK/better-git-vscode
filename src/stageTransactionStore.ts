import * as fs from "fs";
import * as path from "path";

export interface StoredStageTransaction {
    schema: 2;
    kind: "betterGitStage" | "observedIndexChange";
    repoRoot: string;
    headTree: string;
    beforeIndexTree: string;
    afterIndexTree: string;
    uri?: string;
    recordedAt: string;
}

/// Persists the one fail-closed index-transition undo receipt outside an
/// extension host. VS Code may restart one window's host, or dispatch the later
/// F16 shortcut to another window in the same app process; neither event should
/// make a stage that just happened look as though it never existed.
export class StageTransactionStore {
    constructor(private readonly receiptPath: string) {}

    async save(receipt: StoredStageTransaction): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.receiptPath), { recursive: true });
        const temporaryPath = `${this.receiptPath}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.promises.writeFile(
                temporaryPath,
                `${JSON.stringify(receipt)}\n`,
                { encoding: "utf8", mode: 0o600 }
            );
            await fs.promises.rename(temporaryPath, this.receiptPath);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true });
        }
    }

    async load(): Promise<StoredStageTransaction | undefined> {
        try {
            const raw = await fs.promises.readFile(this.receiptPath, "utf8");
            const receipt = JSON.parse(raw) as Partial<StoredStageTransaction>;
            if (
                receipt.schema !== 2 ||
                (receipt.kind !== "betterGitStage" && receipt.kind !== "observedIndexChange") ||
                typeof receipt.repoRoot !== "string" || !receipt.repoRoot ||
                typeof receipt.headTree !== "string" ||
                typeof receipt.beforeIndexTree !== "string" || !receipt.beforeIndexTree ||
                typeof receipt.afterIndexTree !== "string" || !receipt.afterIndexTree ||
                (receipt.uri !== undefined && (typeof receipt.uri !== "string" || !receipt.uri)) ||
                typeof receipt.recordedAt !== "string" || !receipt.recordedAt
            ) {
                return undefined;
            }
            return receipt as StoredStageTransaction;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }
            return undefined;
        }
    }

    async clear(): Promise<void> {
        await fs.promises.rm(this.receiptPath, { force: true });
    }
}
