/** Local, pull-only AgentFlow protocol. No selected text is cached or logged. */
export interface AgentFlowSelectionRequest {
    version: 1;
    nonce: string;
    sourcePID: number;
    gestureStartedAt: number;
    requestedAt: number;
}

export function parseAgentFlowSelectionRequest(value: unknown, now = Date.now()): AgentFlowSelectionRequest | undefined {
    if (!value || typeof value !== "object") { return; }
    const request = value as AgentFlowSelectionRequest;
    if (request.version !== 1 || typeof request.nonce !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(request.nonce) || !Number.isSafeInteger(request.sourcePID) || request.sourcePID <= 0 ||
        !Number.isFinite(request.requestedAt) || !Number.isFinite(request.gestureStartedAt) ||
        request.requestedAt > now + 100 || now - request.requestedAt > 1000 ||
        request.gestureStartedAt > request.requestedAt || request.requestedAt - request.gestureStartedAt > 60_000) { return; }
    return request;
}

export function agentFlowSelectionIsFresh(request: AgentFlowSelectionRequest, changedAt: number, now = Date.now()): boolean {
    // Match this mouse gesture, not an old editor selection left behind while the user reads a webview.
    // A long drag is valid: its last selection update need not occur exactly at mouse-up.
    return Number.isFinite(changedAt) && changedAt >= request.gestureStartedAt - 30 &&
        changedAt <= now && now - request.requestedAt <= 1000;
}
