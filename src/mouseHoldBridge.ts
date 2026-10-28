import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { randomUUID } from "crypto";

/** Private, per-window endpoint: clients pin the accepting socket for the whole physical hold. */
export function startMouseHoldBridge(receive: (packet: unknown) => unknown,
    probe: () => object, directory = process.getuid ? `/tmp/better-git-mouse-${process.getuid()}` : undefined
): { dispose(): void; socketPath: string } | undefined {
    if (!directory || !process.getuid) { return; }
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") { return; } }
    try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) { return; }
    } catch { return; }
    const socketPath = path.join(directory, `vscode-${process.pid}-${randomUUID()}.sock`);
    const clients = new Set<net.Socket>();
    let disposed = false;
    const server = net.createServer(socket => {
        if (disposed || clients.size >= 8) { socket.destroy(); return; }
        clients.add(socket);
        socket.setTimeout(1000, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("close", () => clients.delete(socket));
        let input = Buffer.alloc(0), handled = false;
        socket.on("data", chunk => {
            if (handled) { return; }
            input = Buffer.concat([input, chunk]);
            if (input.length > 1024) { socket.destroy(); return; }
            if (!input.includes(10)) { return; }
            handled = true;
            let reply: unknown = { accepted: false };
            try {
                const packet = JSON.parse(input.toString("utf8").trim());
                reply = packet?.version === 1 && packet.phase === "probe" && Object.keys(packet).length === 2
                    ? probe() : receive(packet);
            } catch { /* Invalid input never reaches editor commands. */ }
            socket.end(JSON.stringify(reply) + "\n");
        });
    });
    server.on("error", () => { /* Optional transport must not prevent extension activation. */ });
    server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { server.close(); }
        if (disposed) { server.close(); }
    });
    server.unref();
    return { socketPath, dispose() {
        disposed = true;
        for (const client of clients) { client.destroy(); }
        server.close();
    } };
}
