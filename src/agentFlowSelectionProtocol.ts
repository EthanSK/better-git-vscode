/** Local, pull-only AgentFlow protocol. No selected text is cached or logged. */
export interface AgentFlowSelectionRequest {
    version: 1;
    nonce: string;
    sourcePID: number;
    gestureStartedAt: number;
    requestedAt: number;
    inputKind?: AgentFlowSelectionKind;
    inputDirection?: AgentFlowSelectionDirection;
}

export type AgentFlowSelectionKind = "mouse" | "keyboard" | "selectAll";
export type AgentFlowSelectionDirection = "left" | "right" | "up" | "down";
export type AgentFlowSelectionEventKind = AgentFlowSelectionKind | "unclassifiedExtension";

/** VS Code labels Select All as Command on some hosts. Permit that case
 * only for an entire document and a matching physical Command-A pull; Git's
 * command-driven hunk selection must never become captured context. */
export function agentFlowSelectionEventKind(kind: number | undefined, fullDocument: boolean,
    extendsSameAnchor = false): AgentFlowSelectionEventKind | undefined {
    if (kind === 2) { return "mouse"; }
    if (kind === 1) { return "keyboard"; }
    if (kind === 3 && fullDocument) { return "selectAll"; }
    // macOS word/line extension can omit the API kind. Never accept that
    // alone: the pull must also prove a fresh physical extension and direction.
    if (kind === undefined && extendsSameAnchor) { return "unclassifiedExtension"; }
    return undefined;
}

export function parseAgentFlowSelectionRequest(value: unknown, now = Date.now()): AgentFlowSelectionRequest | undefined {
    if (!value || typeof value !== "object") { return; }
    const request = value as AgentFlowSelectionRequest;
    if (request.version !== 1 || typeof request.nonce !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(request.nonce) || !Number.isSafeInteger(request.sourcePID) || request.sourcePID <= 0 ||
        !Number.isFinite(request.requestedAt) || !Number.isFinite(request.gestureStartedAt) ||
        request.requestedAt > now + 100 || now - request.requestedAt > 1000 ||
        request.gestureStartedAt > request.requestedAt || request.requestedAt - request.gestureStartedAt > 60_000 ||
        (request.inputKind !== undefined && !["mouse", "keyboard", "selectAll"].includes(request.inputKind)) ||
        (request.inputDirection !== undefined && !["left", "right", "up", "down"].includes(request.inputDirection))) { return; }
    return request;
}

export function agentFlowSelectionIsFresh(request: AgentFlowSelectionRequest, changedAt: number, now = Date.now(),
    selectionKind: AgentFlowSelectionEventKind = "mouse", fullDocument = false,
    selectionDirection?: AgentFlowSelectionDirection): boolean {
    const expected = request.inputKind ?? "mouse"; // Original native clients stay mouse-only.
    // Word/visual-line extension may cross a logical line. Match forward or
    // backward movement without inventing a glyph/word boundary from the text.
    const alignsDirection = request.inputDirection !== undefined && selectionDirection !== undefined &&
        (["right", "down"].includes(request.inputDirection) === ["right", "down"].includes(selectionDirection));
    const matches = expected === "selectAll"
        ? fullDocument && (selectionKind === "selectAll" || selectionKind === "keyboard")
        : expected === selectionKind || (expected === "keyboard" && selectionKind === "unclassifiedExtension" &&
            alignsDirection);
    // Match this actual input kind, not an old selection or a programmatic Git command.
    // A long drag is valid: its last selection update need not occur exactly at mouse-up.
    return matches && Number.isFinite(changedAt) && changedAt >= request.gestureStartedAt - 30 &&
        changedAt <= now && now - request.requestedAt <= 1000;
}
