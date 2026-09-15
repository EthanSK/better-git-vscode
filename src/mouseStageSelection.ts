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
