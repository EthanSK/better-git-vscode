// Classify native text/notebook/media diff resources for shared navigation and hold entry.
// Being a git: resource alone does not make the right side staged: an unstaged deletion has an empty right side.
interface DiffResource { readonly scheme: string; readonly query: string; }

function gitRef(resource: DiffResource): string | undefined {
    if (resource.scheme !== "git") { return undefined; }
    try {
        const value: unknown = JSON.parse(resource.query);
        return value !== null && typeof value === "object" && "ref" in value && typeof value.ref === "string"
            ? value.ref : undefined;
    } catch { return undefined; }
}

export function reviewDiffIsStaged(original: DiffResource, modified: DiffResource, emptyTreeRefs: readonly string[]): boolean {
    if (modified.scheme === "better-git-staged-image") { return true; }
    if (modified.scheme !== "git") { return false; }
    // Ethan's deleted-image eyes entry: the native binary comparison exposes two git: resources. The
    // working/index (~) -> empty-tree pair is an UNSTAGED deletion even when another staged change shares
    // its path. HEAD -> empty-tree remains staged; never turn that view into the recreated working file.
    return !(gitRef(original) === "~" && emptyTreeRefs.includes(gitRef(modified) ?? ""));
}
