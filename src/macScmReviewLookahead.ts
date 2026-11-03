// Asynchronous native presentation for held review. Only the latest visible preview can scroll;
// physical input, selection, release and Git operations never wait for this worker.
import { spawn } from 'child_process';
import { MonitorProcess } from './macKeyReleaseMonitor';
import { ScmReviewLookahead, scmReviewScrollDistance } from './scmReviewLookahead';

interface Target { path: string; remainingFiles: number; sensitivity: number; current: () => boolean; }
type Reply = { id: number; ok: boolean; reason?: string; top?: number; bottom?: number; rowTop?: number; rowHeight?: number };
export class MacScmReviewLookahead {
    private child: MonitorProcess | undefined;
    private readonly pending = new Map<number, { resolve: (reply: Reply | undefined) => void; timer: ReturnType<typeof setTimeout> }>();
    private nextId = 0;
    private failed = false;
    private readonly queue = new ScmReviewLookahead<Target>(
        (target, current) => this.present(target, current), () => this.reset(), () => this.stop());
    constructor(private readonly executable: string, private readonly codePid: number,
        private readonly log: (message: string) => void,
        private readonly options: { platform?: string; spawn?: () => MonitorProcess } = {}) {}
    request(target: Target): void { this.queue.request(target); }
    cancel(): void { this.queue.cancel(); this.failed = false; }
    dispose(): void { this.queue.dispose(); void this.sendReset().finally(() => this.stop()); }
    private async present(target: Target, latest: () => boolean): Promise<void> {
        const current = () => latest() && target.current();
        if (!current() || this.failed || (this.options.platform ?? process.platform) !== 'darwin'
            || !Number.isSafeInteger(this.codePid) || this.codePid <= 0) { return; }
        const id = ++this.nextId;
        const reply = await this.send({ id, action: 'measure', path: target.path });
        if (!current() || !reply?.ok) { if (reply?.reason) { this.log(`SCM lookahead skipped: ${reply.reason}.`); } return; }
        const distance = scmReviewScrollDistance({ top: reply.top ?? NaN, bottom: reply.bottom ?? NaN, rowTop: reply.rowTop ?? NaN,
            rowHeight: reply.rowHeight ?? NaN, remainingFiles: target.remainingFiles, lookahead: 10 });
        if (distance > 0 && Number.isFinite(target.sensitivity) && target.sensitivity > 0) {
            const applied = await this.send({ id, action: 'apply', distance, sensitivity: target.sensitivity });
            if (applied?.ok) { this.log(`SCM lookahead moved the current row by ${Math.round(distance)} points.`); }
        }
    }
    private send(message: { id: number; action: string; path?: string; distance?: number; sensitivity?: number }): Promise<Reply | undefined> {
        const child = this.ensureChild();
        if (!child?.stdin) { return Promise.resolve(undefined); }
        return new Promise(resolve => {
            // A deadline for failed native IPC, not a pause in navigation. Release invalidates presentation immediately and queues native-state restoration.
            const timer = setTimeout(() => { this.failed = true; this.stop(); }, 5000);
            this.pending.set(message.id, { resolve, timer });
            try { child.stdin!.write(JSON.stringify(message) + '\n'); }
            catch { this.failed = true; this.stop(); }
        });
    }
    private ensureChild(): MonitorProcess | undefined {
        if (this.child) { return this.child; }
        let child: MonitorProcess;
        try { child = this.options.spawn?.() ?? spawn(this.executable, [String(this.codePid)],
            { stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as MonitorProcess; }
        catch { this.failed = true; return undefined; }
        this.child = child;
        let buffer = '';
        child.stdout?.on('data', chunk => {
            if (this.child !== child) { return; }
            buffer += chunk.toString();
            if (buffer.length > 8192) { this.failed = true; this.stop(); return; }
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                let reply: Reply;
                try { reply = JSON.parse(line); } catch { this.failed = true; this.stop(); return; }
                if (!this.pending.has(reply?.id) || typeof reply.ok !== 'boolean') { this.failed = true; this.stop(); return; }
                const pending = this.pending.get(reply.id); this.pending.delete(reply.id);
                if (pending) { clearTimeout(pending.timer); pending.resolve(reply); }
            }
        });
        const stopped = () => { if (this.child === child) { this.failed = true; this.stop(); } };
        child.on('exit', stopped); child.on('error', stopped); child.stdin?.on('error', stopped);
        return child;
    }
    private sendReset(): Promise<Reply | undefined> {
        return this.child ? this.send({ id: ++this.nextId, action: 'reset' }) : Promise.resolve(undefined);
    }
    private reset(): void { void this.sendReset(); }
    private stop(): void {
        const child = this.child; this.child = undefined;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
        this.pending.clear();
        const input = child?.stdin;
        if (child && input && "end" in input && typeof input.end === "function") {
            // Let the native worker restore its borrowed accessibility switch even after a timeout.
            // Closing stdin, rather than SIGTERM, runs its normal cleanup without holding up input.
            try { input.end(JSON.stringify({ id: ++this.nextId, action: 'reset' }) + '\n'); }
            catch { child.kill(); return; }
            const deadline = setTimeout(() => child.kill(), 5000); deadline.unref();
            child.on('exit', () => clearTimeout(deadline));
        } else { child?.kill(); }
    }
}
