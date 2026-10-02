export interface MouseStageSelection<T> {
    readonly items: readonly T[];
    readonly anchorIndex: number;
    readonly cursorIndex: number;
    // Files accumulated by hunk preview remain marked when review moves back.
    readonly previewIndices?: readonly number[];
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
    if (!selection.previewIndices?.length) { return selection.items.slice(first, last + 1); }
    const previewed = new Set(selection.previewIndices);
    return selection.items.filter((_, index) => (index >= first && index <= last) || previewed.has(index));
};

export const planMouseStagePreviewBoundary = <T>(
    selection: MouseStageSelection<T>, currentIndex: number, direction: "next" | "previous"
): { selection: MouseStageSelection<T>; target?: T } | undefined => {
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= selection.items.length) {
        return undefined;
    }
    const nextIndex = currentIndex + (direction === "next" ? 1 : -1);
    const hasTarget = nextIndex >= 0 && nextIndex < selection.items.length;
    const cursorIndex = hasTarget ? nextIndex : currentIndex;
    const marked = new Set(selectedMouseStageItems(selection));
    marked.add(selection.items[currentIndex]);
    marked.add(selection.items[cursorIndex]);
    return {
        selection: {
            items: selection.items, anchorIndex: cursorIndex, cursorIndex,
            previewIndices: selection.items.flatMap((item, index) => marked.has(item) ? [index] : []),
        },
        target: hasTarget ? selection.items[cursorIndex] : undefined,
    };
};
