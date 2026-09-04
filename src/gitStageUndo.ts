import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { runWithTransientGitIndexRetry } from "./gitIndexRetry";
import type { StoredStageTransaction } from "./stageTransactionStore";

const exec = promisify(execFile);

export interface IndexSnapshot {
    headTree: string;
    headCommit?: string;
    indexTree: string;
}

export type RestoreResult = "undone" | "head-changed" | "index-changed";

export const sameHead = (left: Pick<IndexSnapshot, "headTree" | "headCommit">,
    right: Pick<IndexSnapshot, "headTree" | "headCommit">): boolean =>
    left.headTree === right.headTree &&
    (left.headCommit === undefined || right.headCommit === undefined || left.headCommit === right.headCommit);

const git = async (root: string, args: string[], env = process.env): Promise<string> =>
    (await exec("git", args, { cwd: root, env, encoding: "utf8" })).stdout.trim();

const readHead = async (root: string): Promise<{ headTree: string; headCommit: string }> => {
    let headCommit: string;
    try {
        headCommit = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    } catch (error) {
        if ((error as { code?: unknown }).code !== 1) {
            throw error;
        }
        return { headTree: "", headCommit: "" }; // unborn branch
    }
    // Resolve the captured commit, not HEAD again while it might be moving.
    return { headCommit, headTree: await git(root, ["rev-parse", `${headCommit}^{tree}`]) };
};

export const readIndexSnapshot = async (root: string): Promise<IndexSnapshot> => {
    const head = await readHead(root);
    const indexTree = await runWithTransientGitIndexRetry(() => git(root, ["write-tree"]));
    return { ...head, indexTree };
};

// Own Git's actual index.lock before checking or replacing the index. Work on a
// private copy because git write-tree/read-tree would otherwise contend with our
// lock. The final rename is the normal atomic Git index installation protocol.
export const restoreStageTransaction = async (receipt: StoredStageTransaction): Promise<RestoreResult> => {
    const root = receipt.repoRoot;
    const indexPath = path.resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
    const lockPath = `${indexPath}.lock`;
    return runWithTransientGitIndexRetry(async () => {
        let lock: fs.promises.FileHandle;
        try {
            lock = await fs.promises.open(lockPath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error(`Unable to create '${lockPath}': File exists.`);
            }
            throw error;
        }
        const temporaryIndex = `${indexPath}.better-git-${randomUUID()}`;
        let installed = false;
        let closed = false;
        try {
            try {
                await fs.promises.copyFile(indexPath, temporaryIndex);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
            const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
            const currentHead = await readHead(root);
            if (!sameHead(receipt, currentHead)) {
                return "head-changed";
            }
            if (await git(root, ["write-tree"], env) !== receipt.afterIndexTree) {
                return "index-changed";
            }
            await git(root, ["read-tree", receipt.beforeIndexTree], env);
            await lock.writeFile(await fs.promises.readFile(temporaryIndex));
            await lock.sync();
            if (!sameHead(currentHead, await readHead(root))) {
                return "head-changed";
            }
            await lock.close();
            closed = true;
            await fs.promises.rename(lockPath, indexPath);
            installed = true;
            return "undone";
        } finally {
            if (!closed) {
                await lock.close();
            }
            // Only remove the lock we created, never a pre-existing Git lock.
            if (!installed) {
                await fs.promises.rm(lockPath, { force: true });
            }
            await fs.promises.rm(temporaryIndex, { force: true });
            await fs.promises.rm(`${temporaryIndex}.lock`, { force: true });
        }
    });
};
