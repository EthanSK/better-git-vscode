import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

interface WindowRegistration {
    name: string;
    created: bigint;
    lastFocused: bigint;
}

const windowNamePattern = /^window-([1-9]\d{0,9})-[0-9a-f-]{36}$/i;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

// VS Code shares User diff settings between windows in a profile. Elect one writer so it can
// recognise its own settings events, and tie a manual choice to the window that made it.
// Lease files live only in the extension's profile storage. — GPT-6.2 Sol
export class DiffViewDisplaySession {
    private readonly name = `window-${process.pid}-${randomUUID()}`;
    private readonly registrationPath: string;
    private readonly overridePath: string;
    private registering: Promise<void> | undefined;
    private disposed = false;

    constructor(private readonly directory: string) {
        this.registrationPath = path.join(directory, this.name);
        this.overridePath = path.join(directory, "manual-layout");
    }

    // File creation order keeps a new window from taking over a live writer. — GPT-6.2 Sol
    async join(focused: boolean): Promise<void> {
        if (this.disposed) { return; }
        this.registering ??= this.register(focused).catch(error => {
            this.registering = undefined;
            throw error;
        });
        await this.registering;
    }

    async focus(): Promise<void> {
        if (!this.registering || this.disposed) { return; }
        await this.registering;
        if (!this.disposed) { await this.recordFocus(); }
    }

    async state(): Promise<{ writer: boolean; manual: boolean }> {
        const windows = await this.windows();
        const writer = windows[0]?.name === this.name && !this.disposed;
        if (!writer) { return { writer: false, manual: false }; }
        const manualOwner = await fs.readFile(this.overridePath, "utf8").catch(error => {
            if (missing(error)) { return undefined; }
            throw error;
        });
        return { writer, manual: windows.some(window => window.name === manualOwner) };
    }

    async holdManualLayout(): Promise<void> {
        const windows = await this.windows();
        if (this.disposed || windows[0]?.name !== this.name) { return; }
        // The native command writes shared User settings, so even a background writer sees it.
        // Use the most recently focused profile window for the lifetime of that choice.
        const origin = windows.reduce((recent, window) =>
            window.lastFocused > recent.lastFocused ? window : recent);
        const temporaryPath = path.join(this.directory, `${this.name}.manual.tmp`);
        await fs.writeFile(temporaryPath, origin.name, { mode: 0o600 });
        try {
            if (!this.disposed) { await fs.rename(temporaryPath, this.overridePath); }
        } finally {
            await fs.rm(temporaryPath, { force: true });
        }
    }

    async clearManualLayout(): Promise<void> {
        if (!this.disposed) { await fs.rm(this.overridePath, { force: true }); }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.registering?.catch(() => undefined);
        await fs.rm(this.registrationPath, { recursive: true, force: true });
    }

    private async register(focused: boolean): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await fs.mkdir(this.registrationPath, { mode: 0o700 });
        if (focused) {
            try { await this.recordFocus(); }
            catch (error) { await fs.rm(this.registrationPath, { recursive: true, force: true }); throw error; }
        }
    }

    private async recordFocus(): Promise<void> {
        // Backdating an unfocused marker on macOS also backdates its creation time. Keep the
        // window's registration directory immutable for election, and track focus inside it.
        await fs.writeFile(path.join(this.registrationPath, "focus"), "", { mode: 0o600 });
    }

    private async windows(): Promise<WindowRegistration[]> {
        const registrations = await Promise.all((await fs.readdir(this.directory, { withFileTypes: true })).map(async entry => {
            if (!entry.isDirectory()) { return undefined; }
            const { name } = entry;
            const match = windowNamePattern.exec(name);
            if (!match) { return undefined; }
            const pid = Number(match[1]);
            if (pid > 0x7fffffff) { return undefined; }
            const directory = path.join(this.directory, name);
            try { process.kill(pid, 0); }
            catch (error) {
                // ESRCH: that window is gone. EPERM: its PID now belongs to another user's process, which
                // cannot be a window of this profile. Rethrowing EPERM made every window lose the election
                // and log a failure every five seconds after an unclean exit. — Claude Fable 5.2
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ESRCH" || code === "EPERM") {
                    await fs.rm(directory, { recursive: true, force: true });
                    return undefined;
                }
                throw error;
            }
            const stat = await fs.stat(directory, { bigint: true }).catch(error => {
                if (missing(error)) { return undefined; }
                throw error;
            });
            if (!stat) { return undefined; }
            const focus = await fs.stat(path.join(directory, "focus"), { bigint: true }).catch(error => {
                if (missing(error)) { return undefined; }
                throw error;
            });
            return { name, created: stat.birthtimeNs, lastFocused: focus?.mtimeNs ?? 0n };
        }));
        return registrations.filter((window): window is WindowRegistration => !!window)
            .sort((left, right) => left.created < right.created ? -1
                : left.created > right.created ? 1 : left.name.localeCompare(right.name));
    }
}
