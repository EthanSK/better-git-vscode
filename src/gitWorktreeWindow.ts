import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";

// Folder windows take precedence over another window which merely discovered the
// same Git worktree. Receivers of equal rank keep their own window.
export type WorktreeWindowRank = 0 | 1 | 2 | 3;

export async function worktreeWindowRank(root: string, folders: readonly string[],
    repositoryRoots: () => readonly string[], singleFolder: boolean): Promise<WorktreeWindowRank> {
    const matches = async (paths: readonly string[]) => paths.includes(root) ||
        (await Promise.all(paths.map(value => fs.realpath(value).catch(() => undefined)))).includes(root);
    if (await matches(folders)) { return singleFolder ? 3 : 2; }
    return await matches(repositoryRoots()) ? 1 : 0;
}

// VS Code delivers extension URLs to the active workbench. Each workbench has a
// separate extension host even when all windows share the same macOS app PID.
// Ask the other live hosts on demand and let the exact owning workbench focus
// itself. No title matching, browser redispatch, Git status or background polling.
export class GitWorktreeWindowRouter {
    private readonly server = net.createServer(socket => this.receive(socket));
    private readonly connections = new Set<net.Socket>();
    private readonly endpoint: string;
    private readonly prefix: string;
    private readonly ready: Promise<boolean>;
    private disposed = false;

    constructor(private readonly directory: string, profile: string, editorPid: number,
        private readonly rank: (root: string) => Promise<WorktreeWindowRank>,
        private readonly open: (root: string, link: string, isLive: () => boolean) => Promise<boolean>,
        private readonly log: (message: string) => void) {
        const profileKey = createHash("sha256").update(profile).digest("hex").slice(0, 16);
        this.prefix = `${editorPid}-${profileKey}-`;
        this.endpoint = path.join(directory, `${this.prefix}${randomUUID().slice(0, 12)}.sock`);
        this.ready = this.listen().catch(error => {
            if (!this.disposed) { this.log(`Window routing unavailable: ${String(error)}`); }
            return false;
        });
    }

    async forward(root: string, link: string, isCurrent: () => boolean): Promise<boolean> {
        if (!await this.ready || this.disposed || !isCurrent()) { return false; }
        try {
            const localRank = await this.rank(root);
            if (localRank === 3 || !isCurrent()) { return false; }
            const peers = (await fs.readdir(this.directory)).filter(name => name.startsWith(this.prefix)
                && /^[\da-f]{8}-[\da-f]{3}\.sock$/.test(name.slice(this.prefix.length))
                && name !== path.basename(this.endpoint));
            const candidates = await Promise.all(peers.map(async name => {
                const endpoint = path.join(this.directory, name);
                return { endpoint, rank: Number(await callWindow(endpoint, { root }) ?? 0) };
            }));
            const best = Math.max(localRank, ...candidates.map(candidate => candidate.rank));
            const winners = candidates.filter(candidate => candidate.rank === best);
            // Ambiguous live owners do not justify changing windows. Prefer the
            // receiver if it already owns the worktree, as before this feature.
            if (!isCurrent() || best <= localRank || winners.length !== 1) { return false; }
            const result = await callWindow(winners[0].endpoint, { root, link, rank: best });
            // A peer can have accepted the link before its reply was lost.
            // Only an explicit refusal or failed connection can fall back locally.
            return result !== "0";
        } catch (error) {
            this.log(`Could not match the worktree to another window: ${String(error)}`);
            return false;
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const socket of this.connections) { socket.destroy(); }
        this.server.close();
    }

    private async listen(): Promise<boolean> {
        await fs.mkdir(this.directory, { mode: 0o700, recursive: true });
        const stat = await fs.lstat(this.directory);
        if (this.disposed || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
            return false;
        }
        return await new Promise((resolve, reject) => {
            this.server.on("error", error => {
                this.log(`Worktree window socket failed: ${String(error)}`);
                reject(error);
            });
            this.server.listen(this.endpoint, () => {
                if (this.disposed) { this.server.close(); }
                resolve(!this.disposed);
            });
        });
    }

    private receive(socket: net.Socket): void {
        if (this.disposed || this.connections.size >= 16) { socket.destroy(); return; }
        this.connections.add(socket);
        socket.on("close", () => this.connections.delete(socket));
        socket.on("error", () => socket.destroy());
        socket.setTimeout(1000, () => socket.destroy());
        socket.setEncoding("utf8");
        let input = "";
        const read = (chunk: string) => {
            input += chunk;
            if (input.length > 16_384) { socket.destroy(); return; }
            if (!input.endsWith("\n")) { return; }
            socket.off("data", read);
            void this.reply(input, socket).then(reply => socket.end(reply), () => socket.end("0"));
        };
        socket.on("data", read);
    }

    private async reply(input: string, socket: net.Socket): Promise<string> {
        const request = JSON.parse(input) as { root?: unknown; link?: unknown; rank?: unknown } | null;
        const root = request?.root;
        if (typeof root !== "string" || !path.isAbsolute(root) || /[\0\r\n]/.test(root)) { return "0"; }
        const rank = await this.rank(root);
        if (request?.link === undefined) { return String(rank); }
        if (this.disposed || socket.destroyed || typeof request.link !== "string" || !rank || rank !== request.rank) {
            return "0";
        }
        return await this.open(root, request.link, () => !this.disposed && !socket.destroyed) ? "opened" : "0";
    }
}

function callWindow(endpoint: string, request: { root: string; link?: string; rank?: number }): Promise<string | undefined> {
    return new Promise(resolve => {
        const socket = net.createConnection(endpoint);
        let response = "";
        let sent = false;
        socket.setEncoding("utf8");
        socket.setTimeout(1000, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("connect", () => {
            sent = true;
            socket.write(`${JSON.stringify(request)}\n`);
        });
        socket.on("data", chunk => {
            response += chunk;
            if (response.length > 16) { socket.destroy(); }
        });
        socket.on("end", () => resolve(/^[0-3]$|^opened$/.test(response) ? response : undefined));
        socket.on("close", () => resolve(sent ? undefined : "0"));
    });
}
