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

// Ethan (2026-11-19): "sometimes BetterGit is skipping ... file as I go down". His live log showed a
// six-minute hold whose file list had been captured at the hold threshold. Another agent then changed
// a file further down that list (it became newly unstaged ninety seconds into the hold), so the walk
// stepped straight over it and the release left it behind. The pending SET must stay exactly what he
// built, but the road AHEAD of him has to follow the live Changes list, like ordinary Next already does.
//
// Call this just before a step. It rebuilds ONLY the files strictly beyond `fromIndex` in the direction
// of travel, in the live list's order:
//   - a file that has become changed since the snapshot is added, so the next step lands on it;
//   - an unmarked file that is no longer changed is dropped, so a step is not spent on (or, in eyes mode,
//     blocked by) a file with nothing left to review;
//   - every MARKED file, the cursor and everything at or behind `fromIndex` are kept untouched, even when
//     Git no longer lists them. Membership is Ethan's decision; only release, cancel or his own reverse
//     movement may change it.
// Matching is by `key` (the file URI), never by index, because adding or dropping a file shifts indices.
// Returns the SAME selection object when nothing ahead changed, so identity checks by callers still hold.
// Pure and synchronous: no Git process, no wait, no I/O on the press path. — Claude Fable 5.2
export const reconcileMouseStageSelection = <T>(
    selection: MouseStageSelection<T>,
    fromIndex: number,
    direction: "next" | "previous",
    liveItems: readonly T[],
    key: (item: T) => string
): { selection: MouseStageSelection<T>; fromIndex: number } => {
    const items = selection.items;
    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= items.length) {
        return { selection, fromIndex };
    }
    const forward = direction === "next";
    // Think in travel order for both directions: "fixed" is the current file plus everything already
    // behind it, "ahead" is what the next steps will reach, nearest first.
    const fixed = forward ? items.slice(0, fromIndex + 1) : items.slice(fromIndex);
    const oldAhead = forward ? items.slice(fromIndex + 1) : items.slice(0, fromIndex).reverse();
    const live = forward ? liveItems : [...liveItems].reverse();
    const fixedKeys = new Set(fixed.map(key));
    // "Ahead" in the live list starts just past the furthest fixed file Git still lists. If the current
    // file itself has left the list, a new neighbour cannot be placed exactly; treating it as ahead means
    // it is visited instead of skipped.
    let aheadStart = 0;
    live.forEach((item, index) => { if (fixedKeys.has(key(item))) { aheadStart = index + 1; } });
    const ahead = live.slice(aheadStart);
    const aheadKeys = new Set(ahead.map(key));
    const markedKeys = new Set(selection.selectedIndices.map(index => key(items[index])));
    // A marked file ahead that Git no longer lists keeps its place next to its old neighbours.
    oldAhead.forEach((item, index) => {
        const itemKey = key(item);
        if (aheadKeys.has(itemKey) || !markedKeys.has(itemKey)) { return; }
        const follower = oldAhead.slice(index + 1).find(later => aheadKeys.has(key(later)));
        const position = follower === undefined ? ahead.length : ahead.findIndex(candidate => key(candidate) === key(follower));
        ahead.splice(position, 0, item);
        aheadKeys.add(itemKey);
    });
    if (ahead.length === oldAhead.length && ahead.every((item, index) => key(item) === key(oldAhead[index]))) {
        return { selection, fromIndex };
    }
    const nextItems = forward ? [...fixed, ...ahead] : [...ahead.reverse(), ...fixed];
    const indexByKey = new Map(nextItems.map((item, index) => [key(item), index]));
    const remap = (index: number): number | undefined => indexByKey.get(key(items[index]));
    const cursorIndex = remap(selection.cursorIndex);
    // Unreachable while the cursor stays marked (every mover marks it); never guess a cursor if it is not.
    if (cursorIndex === undefined) { return { selection, fromIndex }; }
    return {
        selection: {
            ...selection,
            items: nextItems,
            cursorIndex,
            selectedIndices: selection.selectedIndices.map(remap).filter((index): index is number => index !== undefined),
            reviewedEndpoint: selection.reviewedEndpoint === undefined ? undefined : remap(selection.reviewedEndpoint),
        },
        fromIndex: forward ? fromIndex : nextItems.length - fixed.length,
    };
};
