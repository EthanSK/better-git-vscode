export interface MouseStageSelection<T> {
    readonly items: readonly T[];
    readonly anchorIndex: number;
    readonly cursorIndex: number;
}

export const createMouseStageSelection = <T>(
    items: readonly T[],
    anchorIndex: number
): MouseStageSelection<T> | undefined => {
    if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= items.length) {
        return undefined;
    }
    return { items, anchorIndex, cursorIndex: anchorIndex };
};

export const moveMouseStageSelection = <T>(
    selection: MouseStageSelection<T>,
    delta: -1 | 1
): MouseStageSelection<T> => ({
    ...selection,
    cursorIndex: Math.max(0, Math.min(selection.items.length - 1, selection.cursorIndex + delta)),
});

export const selectedMouseStageItems = <T>(selection: MouseStageSelection<T>): readonly T[] => {
    const first = Math.min(selection.anchorIndex, selection.cursorIndex);
    const last = Math.max(selection.anchorIndex, selection.cursorIndex);
    return selection.items.slice(first, last + 1);
};

export const planMouseStageBoundary = <T>(
    selection: MouseStageSelection<T>, currentIndex: number, direction: "next" | "previous"
): { staged: readonly T[]; remaining: readonly T[]; target?: T } | undefined => {
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= selection.items.length) {
        return undefined;
    }
    const marked = selectedMouseStageItems(selection);
    const current = selection.items[currentIndex];
    const staged = marked.includes(current) ? marked : [...marked, current];
    const stagedSet = new Set(staged);
    const stagedIndices = selection.items.map((item, index) => stagedSet.has(item) ? index : -1)
        .filter(index => index >= 0);
    const first = Math.min(...stagedIndices);
    const last = Math.max(...stagedIndices);
    const remaining = selection.items.filter(item => !stagedSet.has(item));
    const after = selection.items.slice(last + 1).find(item => !stagedSet.has(item));
    const before = selection.items.slice(0, first).reverse().find(item => !stagedSet.has(item));
    return { staged, remaining, target: direction === "next" ? after ?? before : before ?? after };
};
