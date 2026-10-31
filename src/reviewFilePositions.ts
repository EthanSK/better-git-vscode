// Session-only coordinate memory used by extension.ts when revisiting an unfinished Git review.
import type { StageUndoView } from "./stageTransactionStore";

// Ethan: returning to a visited UNSTAGED file resumes its last cursor and scroll position. Staging clears
// that file's entry; failed staging does not. Store only coordinates, never documents or editor objects.
// This session-only cache is separate from the three-entry exact Undo history. Bound it even in huge repos.
export class ReviewFilePositions {
    private readonly views = new Map<string, StageUndoView>();

    constructor(private readonly limit = 512) {}

    remember(view: StageUndoView): void {
        this.views.delete(view.fileUri);
        const moved = (view.topLine ?? 0) > 0 || view.selections.some(selection =>
            selection.anchor.line !== 0 || selection.anchor.character !== 0
            || selection.active.line !== 0 || selection.active.character !== 0);
        if (!moved) { return; } // Returning deliberately to the default position also replaces an old entry.
        this.views.set(view.fileUri, {
            ...view,
            selections: view.selections.slice(0, 16).map(selection => ({
                anchor: { ...selection.anchor }, active: { ...selection.active },
            })),
        });
        const oldest = this.views.keys().next().value;
        if (this.views.size > this.limit && oldest !== undefined) { this.views.delete(oldest); }
    }

    get(fileUri: string): StageUndoView | undefined {
        const view = this.views.get(fileUri);
        if (view) { this.views.delete(fileUri); this.views.set(fileUri, view); }
        return view;
    }

    forget(fileUri: string): void { this.views.delete(fileUri); }
    retain(keep: (fileUri: string) => boolean): void {
        for (const key of this.views.keys()) { if (!keep(key)) { this.views.delete(key); } }
    }
    clear(): void { this.views.clear(); }
}
