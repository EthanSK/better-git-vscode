// One immutable pending stage set for mouse, wand and keyboard review; Git changes only when its owner finishes.
// History guard: Ethan corrected "stage while scrolling" to ADD TO THE SET (2026-10-02), never Git add on
// each ratchet. His subsequent reverse-removal and eyes-preview decisions apply to this SAME set in both
// modes. The 2026-11-03 terminal approval is the narrow exception to excluding an unfinished eyes preview.
export interface MouseStageSelection<T> {
    readonly items: readonly T[];
    readonly cursorIndex: number;
    readonly initialDirection: "next" | "previous";
    readonly selectedIndices: readonly number[];
    readonly rebaseDirectionAtEndpoint?: boolean;
    readonly reviewedEndpoint?: number;
}

export const createMouseStageSelection = <T>(
    items: readonly T[],
    anchorIndex: number,
    initialDirection: "next" | "previous" = "next",
    rebaseDirectionAtEndpoint = false
): MouseStageSelection<T> | undefined => {
    if (!Number.isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= items.length) {
        return undefined;
    }
    return { items, cursorIndex: anchorIndex, initialDirection, selectedIndices: [anchorIndex], rebaseDirectionAtEndpoint };
};

// Ethan: reversing the direction that built a range must remove the file being left, even after switching
// eyes <-> explosion mode. Both modes edit this one set; mode toggles never rebuild a remembered old range.
const moveToMouseStageItem = <T>(
    selection: MouseStageSelection<T>, currentIndex: number, cursorIndex: number
): MouseStageSelection<T> => {
    if (currentIndex === cursorIndex) { return selection; }
    const marked = new Set(selection.selectedIndices);
    const direction = cursorIndex > currentIndex ? "next" : "previous";
    // Wand circles have no held Next/Previous button to choose a permanent direction.
    // After undoing the range, either direction can start a new range from this endpoint.
    // Physical mouse holds retain their existing fixed-direction behaviour.
    const initialDirection = selection.rebaseDirectionAtEndpoint && marked.size === 1 && marked.has(currentIndex)
        ? direction : selection.initialDirection;
    if (direction === initialDirection) { marked.add(currentIndex); }
    else { marked.delete(currentIndex); }
    marked.add(cursorIndex);
    return { ...selection, initialDirection, cursorIndex, selectedIndices: [...marked], reviewedEndpoint: undefined };
};

export const moveMouseStageSelection = <T>(
    selection: MouseStageSelection<T>,
    delta: -1 | 1
): MouseStageSelection<T> => moveToMouseStageItem(selection, selection.cursorIndex,
    Math.max(0, Math.min(selection.items.length - 1, selection.cursorIndex + delta)));

// Ethan: an extra review step past the last/first file means "I've finished this file". It becomes explosion,
// not an endlessly excluded eyes preview. This one value owns both the badge and release membership.
export const mouseStagePreviewIndex = <T>(selection: MouseStageSelection<T>): number | undefined =>
    selection.reviewedEndpoint === selection.cursorIndex ? undefined : selection.cursorIndex;

export const selectedMouseStageItems = <T>(
    selection: MouseStageSelection<T>, excludeCurrent = false
): readonly T[] => {
    const marked = new Set(selection.selectedIndices);
    // Ethan's eyes mode is a preview: releasing stages the reviewed files before this one, so he can stop
    // on a file that needs more analysis. File/explosion mode includes the endpoint. Compute this at finish
    // without mutating the shared selection, so switching modes midway preserves every earlier decision.
    if (excludeCurrent && mouseStagePreviewIndex(selection) !== undefined) { marked.delete(selection.cursorIndex); }
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
    if (!hasTarget) {
        // Only a real file-boundary callback approves this terminal file: viewing its final hunk alone does
        // not. Keep it pending until release, idempotent on further ratchets, and never wrap worktrees. A
        // manually opened terminal file is the endpoint too; do not invent a range through unvisited gaps.
        return { selection: { ...selection, cursorIndex: currentIndex, reviewedEndpoint: currentIndex,
            selectedIndices: [...new Set([...selection.selectedIndices, currentIndex])] } };
    }
    const cursorIndex = nextIndex;
    return {
        selection: moveToMouseStageItem(selection, currentIndex, cursorIndex),
        target: hasTarget ? selection.items[cursorIndex] : undefined,
    };
};
