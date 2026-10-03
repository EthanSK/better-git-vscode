export interface MouseStageSelection<T> {
    readonly items: readonly T[];
    readonly cursorIndex: number;
    readonly initialDirection: "next" | "previous";
    readonly selectedIndices: readonly number[];
}

export const createMouseStageSelection = <T>(
    items: readonly T[],
    anchorIndex: number,
    initialDirection: "next" | "previous" = "next"
): MouseStageSelection<T> | undefined => {
    if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= items.length) {
        return undefined;
    }
    return { items, cursorIndex: anchorIndex, initialDirection, selectedIndices: [anchorIndex] };
};

// Both wheel modes edit the same set. Toggling modes cannot restore an old range.
const moveToMouseStageItem = <T>(
    selection: MouseStageSelection<T>, currentIndex: number, cursorIndex: number
): MouseStageSelection<T> => {
    if (currentIndex === cursorIndex) { return selection; }
    const marked = new Set(selection.selectedIndices);
    const direction = cursorIndex > currentIndex ? "next" : "previous";
    if (direction === selection.initialDirection) { marked.add(currentIndex); }
    else { marked.delete(currentIndex); }
    marked.add(cursorIndex);
    return { ...selection, cursorIndex, selectedIndices: [...marked] };
};

export const moveMouseStageSelection = <T>(
    selection: MouseStageSelection<T>,
    delta: -1 | 1
): MouseStageSelection<T> => moveToMouseStageItem(selection, selection.cursorIndex,
    Math.max(0, Math.min(selection.items.length - 1, selection.cursorIndex + delta)));

export const selectedMouseStageItems = <T>(
    selection: MouseStageSelection<T>, excludeCurrent = false
): readonly T[] => {
    const marked = new Set(selection.selectedIndices);
    if (excludeCurrent) { marked.delete(selection.cursorIndex); }
    return selection.items.filter((_, index) => marked.has(index));
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
    return {
        selection: moveToMouseStageItem(selection, currentIndex, cursorIndex),
        target: hasTarget ? selection.items[cursorIndex] : undefined,
    };
};
