interface StageTransactionSteps {
    prepareUndo: () => Promise<void>;
    stage: () => Promise<void>;
    saveUndo: () => Promise<void>;
    onUndoError: (error: unknown) => void;
}

/// The index mutation must finish before advancing. Receipt persistence uses
/// the existing ordered observer queue: enqueue it before returning, but let
/// the user review the next file while it finishes. The next stage's prepare
/// and an immediate Undo are barriers on that same queue, so neither can
/// overtake this receipt. Do not hold that queue across stage(): external Git
/// transitions during the mutation still need their own observations.
export const stageWithDeferredReceipt = async (steps: StageTransactionSteps): Promise<"queued" | "unavailable"> => {
    let prepared = true;
    let preparationError: unknown;
    try {
        await steps.prepareUndo();
    } catch (error) {
        prepared = false;
        preparationError = error;
    }
    // Never turn an actual staging failure into an informational Undo warning.
    await steps.stage();
    if (!prepared) {
        steps.onUndoError(preparationError);
        return "unavailable";
    }
    try {
        void steps.saveUndo().catch(steps.onUndoError);
    } catch (error) {
        steps.onUndoError(error);
        return "unavailable";
    }
    return "queued";
};
