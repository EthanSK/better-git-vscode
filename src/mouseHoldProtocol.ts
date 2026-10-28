import { HeldWheelBurst } from "./heldWheelBurst";

export type PhysicalMouseSource = "corsair" | "razer";
export interface MouseHoldPacket {
    version: 1;
    phase: "begin" | "ready" | "step" | "mode" | "short-release" | "boundary" | "finish" | "cancel" | "abandon" | "heartbeat";
    id: string;
    seq: number;
    source: PhysicalMouseSource;
    direction: "next" | "previous";
    mode: "changes" | "files";
}

export function parseMouseHoldPacket(value: unknown): MouseHoldPacket | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) { return; }
    const p = value as Record<string, unknown>;
    const keys = ["version", "phase", "id", "seq", "source", "direction", "mode"];
    if (Object.keys(p).length !== keys.length || Object.keys(p).some(key => !keys.includes(key)) || p.version !== 1
        || typeof p.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(p.id)
        || !Number.isSafeInteger(p.seq) || (p.seq as number) < 1 || (p.seq as number) > 2147483647
        || !["begin", "ready", "step", "mode", "short-release", "boundary", "finish", "cancel", "abandon", "heartbeat"].includes(String(p.phase))
        || (p.source !== "corsair" && p.source !== "razer")
        || (p.direction !== "next" && p.direction !== "previous") || (p.mode !== "changes" && p.mode !== "files")) { return; }
    return p as unknown as MouseHoldPacket;
}

type Session = { packet: MouseHoldPacket; direction: MouseHoldPacket["direction"]; received: number; ending: boolean; pending: number; fingerprints: Map<number, string> };
export interface MouseHoldReply { accepted: boolean; id?: string; seq?: number; expectedSeq?: number; }

/** Window-local physical gesture admission. The existing navigation queue still owns all UI/index work. */
export class MouseHoldProtocol {
    private session?: Session;
    private tail = Promise.resolve();
    private readonly retired = new Set<string>();
    private readonly wheel: HeldWheelBurst;

    constructor(private readonly hooks: {
        canBegin: () => boolean;
        begin: (packet: MouseHoldPacket) => Promise<void>;
        perform: (packet: MouseHoldPacket, mayStart: () => boolean) => Promise<void>;
        abandon: () => void;
    }, private readonly now: () => number = () => performance.now()) {
        this.wheel = new HeldWheelBurst(now);
    }

    get canBegin(): boolean { return !this.session && this.hooks.canBegin(); }
    settled(): Promise<void> { return this.tail; }

    receive(value: unknown): MouseHoldReply {
        const packet = parseMouseHoldPacket(value);
        if (!packet || this.retired.has(packet.id)) { return { accepted: false }; }
        if (packet.phase === "begin" && !this.session) {
            if (packet.seq !== 1 || !this.canBegin) { return { accepted: false }; }
            const session: Session = { packet, direction: packet.direction, received: this.now(), ending: false, pending: 1,
                fingerprints: new Map([[1, JSON.stringify(packet)]]) };
            this.session = session;
            // Begin captures the focused tab synchronously, before another app can become frontmost.
            let begun: Promise<void>;
            try { begun = this.hooks.begin(packet); } catch { this.drop(); return { accepted: false }; }
            this.tail = begun.catch(() => { if (this.session === session) { this.drop(); } }).finally(() => { session.pending--; });
            return { accepted: true, id: packet.id, seq: packet.seq };
        }
        const session = this.session;
        if (!session || session.packet.id !== packet.id || session.packet.source !== packet.source) { return { accepted: false }; }
        if (packet.phase !== "step" && packet.direction !== session.direction) { return { accepted: false }; }
        const fingerprint = JSON.stringify(packet);
        const prior = session.fingerprints.get(packet.seq);
        if (prior) { return { accepted: prior === fingerprint, id: packet.id, seq: packet.seq }; }
        if (session.ending || packet.phase === "begin" || packet.seq !== session.packet.seq + 1) {
            return { accepted: false, expectedSeq: session.packet.seq + 1 };
        }
        if (session.pending >= 64) { this.drop(); return { accepted: false }; }
        session.packet = packet;
        session.received = this.now();
        session.fingerprints.set(packet.seq, fingerprint);
        if (session.fingerprints.size > 64) { session.fingerprints.delete(session.fingerprints.keys().next().value!); }
        const terminal = ["boundary", "finish", "cancel", "abandon"].includes(packet.phase);
        if (terminal) { session.ending = true; }
        if (packet.phase === "heartbeat") { return { accepted: true, id: packet.id, seq: packet.seq }; }
        if (packet.phase === "abandon") { this.drop(); return { accepted: true, id: packet.id, seq: packet.seq }; }
        const mayStart = packet.phase === "step" ? this.wheel.admit(session) : () => true;
        session.pending++;
        this.tail = this.tail.then(async () => {
            if (this.session !== session) { return; }
            await this.hooks.perform(packet, mayStart);
            if (terminal && this.session === session) { this.retire(session); }
        }).catch(() => { if (this.session === session) { this.drop(); } }).finally(() => { session.pending--; });
        return { accepted: true, id: packet.id, seq: packet.seq };
    }

    expire(): void {
        if (this.session && !this.session.ending && this.now() - this.session.received > 3000) { this.drop(); }
    }

    drop(): void {
        const session = this.session;
        if (!session) { return; }
        this.retire(session);
        this.hooks.abandon();
    }

    private retire(session: Session): void {
        if (this.session === session) { this.session = undefined; }
        this.retired.add(session.packet.id);
        if (this.retired.size > 64) { this.retired.delete(this.retired.values().next().value!); }
    }
}
