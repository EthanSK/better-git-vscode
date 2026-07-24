// VS Code git API Status enum (extensions/git/src/api/git.d.ts). The git extension API is not typed in this
// project, so this shared map keeps every raw status value documented and prevents feature-specific magic numbers.
export const GitStatus = {
    INDEX_MODIFIED: 0,   // staged edit
    INDEX_ADDED: 1,      // staged new file (no HEAD side)
    INDEX_DELETED: 2,    // staged deletion (no index side)
    INDEX_RENAMED: 3,    // staged rename (HEAD side is at the ORIGINAL path)
    INDEX_COPIED: 4,     // staged copy   (HEAD side is at the ORIGINAL path)
    MODIFIED: 5,         // unstaged edit
    DELETED: 6,          // unstaged deletion
    UNTRACKED: 7,        // brand-new file, not yet added
    IGNORED: 8,          // gitignored — skipped
    INTENT_TO_ADD: 9,    // `git add -N` — treated like a new file (no HEAD side)
    INTENT_TO_RENAME: 10,
    TYPE_CHANGED: 11,    // e.g. file <-> symlink
    ADDED_BY_US: 12,     // ── merge conflicts ──
    ADDED_BY_THEM: 13,
    DELETED_BY_US: 14,
    DELETED_BY_THEM: 15,
    BOTH_ADDED: 16,
    BOTH_DELETED: 17,
    BOTH_MODIFIED: 18,
} as const;
