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

export function worktreeLinkReturnsToCodex(link: Parameters<typeof parseWorktreeLink>[0]): boolean {
    const targets = new URLSearchParams(link.query).getAll("returnTo");
    return parseWorktreeLink(link) !== undefined && targets.length === 1 && targets[0] === "codex";
}

export function createWorktreeLink(root: string, scheme = "vscode", returnToCodex = false): string {
    // Encode parentheses too: an unmatched ')' would terminate a Markdown link.
    const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const uri = `${scheme}://${WORKTREE_LINK_AUTHORITY}${WORKTREE_LINK_PATH}?path=${encode(root)}${returnToCodex ? "&returnTo=codex" : ""}`;
    // The redirect decodes its url value again after query parsing. Preserve
    // the inner path encoding through both layers (notably +, %, # and &).
    return `https://vscode.dev/redirect?url=${encode(encode(uri))}`;
}
