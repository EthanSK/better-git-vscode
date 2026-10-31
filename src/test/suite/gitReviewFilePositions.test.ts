// Non-GUI checks for bounded unfinished-review coordinate memory; run through npm test.
import * as assert from "assert";
import { ReviewFilePositions } from "../../reviewFilePositions";
import type { StageUndoView } from "../../stageTransactionStore";

suite("Unstaged review positions", () => {
    const view = (fileUri = "file:///repo/a.ts", topLine = 50): StageUndoView => ({
        fileUri, documentUri: fileUri, topLine,
        selections: [{ anchor: { line: 60, character: 3 }, active: { line: 62, character: 5 } }],
    });
    test("keeps exact cursor, selection and scroll coordinates without retaining caller objects", () => {
        const cache = new ReviewFilePositions();
        const saved = view(); cache.remember(saved);
        saved.selections[0].active.line = 999;
        assert.strictEqual(cache.get(saved.fileUri)?.topLine, 50);
        assert.strictEqual(cache.get(saved.fileUri)?.selections[0].active.line, 62);
    });
    test("isolates full file identities and forgets only staged paths", () => {
        const cache = new ReviewFilePositions();
        const a = view(), b = view("file:///other-repo/a.ts", 90);
        cache.remember(a); cache.remember(b); cache.forget(a.fileUri);
        assert.strictEqual(cache.get(a.fileUri), undefined);
        assert.strictEqual(cache.get(b.fileUri)?.topLine, 90);
    });
    test("does not retain default positions and deliberately returning to top clears an older view", () => {
        const cache = new ReviewFilePositions(), saved = view(); cache.remember(saved);
        cache.remember({ ...saved, topLine: 0, selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } }] });
        assert.strictEqual(cache.get(saved.fileUri), undefined);
    });
    test("bounds coordinates by least recent use and prunes staged or closed repositories", () => {
        const cache = new ReviewFilePositions(2);
        for (const name of ["a", "b"]) { cache.remember(view(name)); }
        cache.get("a"); cache.remember(view("c"));
        assert.strictEqual(cache.get("b"), undefined);
        cache.retain(key => key === "c"); assert.strictEqual(cache.get("a"), undefined);
        assert.ok(cache.get("c")); cache.clear(); assert.strictEqual(cache.get("c"), undefined);
    });
});
