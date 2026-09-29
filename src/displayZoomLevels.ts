export interface DisplayZoomLevels {
    connected: number;
    disconnected: number;
}

export function parseDisplayZoomLevels(value: unknown): DisplayZoomLevels | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) { return undefined; }
    const levels = value as Partial<DisplayZoomLevels>;
    if (typeof levels.connected !== "number" || !Number.isFinite(levels.connected)
        || typeof levels.disconnected !== "number" || !Number.isFinite(levels.disconnected)
        || levels.connected < -8 || levels.connected > 8
        || levels.disconnected < -8 || levels.disconnected > 8) { return undefined; }
    return { connected: levels.connected, disconnected: levels.disconnected };
}
