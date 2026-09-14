import * as path from "path";

export const WORKTREE_LINK_AUTHORITY = "ethansk.better-git-vscode";
export const WORKTREE_LINK_PATH = "/open-worktree";

// Query values are decoded exactly once. Do not interpret URLs, commands or
// relative paths as filesystem roots, even when a link comes from a trusted chat.
export function parseWorktreeLink(link: { authority: string; path: string; query: string; fragment: string }): string | undefined {
    if (link.authority.toLowerCase() !== WORKTREE_LINK_AUTHORITY || link.path !== WORKTREE_LINK_PATH || link.fragment) {
        return undefined;
    }
    const values = new URLSearchParams(link.query).getAll("path");
    const root = values.length === 1 ? values[0] : undefined;
    return root && path.isAbsolute(root) && !/[\0\r\n]/.test(root) ? root : undefined;
}

export function normalizeReturnApp(value: unknown): string | undefined {
    // Keep the original Codex links working. All other destinations are macOS bundle IDs,
    // never executable paths, display names, shell snippets or another URL.
    if (value === "codex") { return "com.openai.codex"; }
    return typeof value === "string" && value.length <= 255
        && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value) ? value : undefined;
}

export function worktreeLinkReturnApp(
    link: Parameters<typeof parseWorktreeLink>[0], enabled: boolean, fallback?: string
): string | undefined {
    if (!enabled || parseWorktreeLink(link) === undefined) { return undefined; }
    const targets = new URLSearchParams(link.query).getAll("returnTo");
    // Explicit invalid/duplicate metadata must never fall back to a different destination.
    return targets.length === 0 ? normalizeReturnApp(fallback)
        : targets.length === 1 ? normalizeReturnApp(targets[0]) : undefined;
}

export function createWorktreeLink(root: string, scheme = "vscode", returnApp?: string): string {
    // Encode parentheses too: an unmatched ')' would terminate a Markdown link.
    const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const destination = normalizeReturnApp(returnApp);
    const uri = `${scheme}://${WORKTREE_LINK_AUTHORITY}${WORKTREE_LINK_PATH}?path=${encode(root)}${destination ? `&returnTo=${encode(destination)}` : ""}`;
    // The redirect decodes its url value again after query parsing. Preserve
    // the inner path encoding through both layers (notably +, %, # and &).
    return `https://vscode.dev/redirect?url=${encode(encode(uri))}`;
}
