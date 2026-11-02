// Git-side semantics for deleted comparisons; all review entry points must use the same classification.
import * as assert from "assert";
import { reviewDiffIsStaged } from "../../gitReviewDiff";

suite("Native review diff side", () => {
    const git = (ref: string) => ({ scheme: "git", query: JSON.stringify({ ref }) });
    const file = { scheme: "file", query: "" };
    const empty = ["sha1-empty-tree", "sha256-empty-tree"];
    test("deleted working comparisons stay unstaged for both repository hash algorithms", () => {
        for (const ref of empty) { assert.strictEqual(reviewDiffIsStaged(git("~"), git(ref), empty), false); }
    });
    test("staged deletions, additions and modifications retain their side", () => {
        assert.strictEqual(reviewDiffIsStaged(git("HEAD"), git(empty[0]), empty), true);
        assert.strictEqual(reviewDiffIsStaged(git(empty[0]), git(""), empty), true);
        assert.strictEqual(reviewDiffIsStaged(git("HEAD"), git(""), empty), true);
        assert.strictEqual(reviewDiffIsStaged(git("HEAD"), { scheme: "better-git-staged-image", query: "" }, empty), true);
    });
    test("ordinary working edits and additions stay unstaged", () => {
        assert.strictEqual(reviewDiffIsStaged(git("~"), file, empty), false);
        assert.strictEqual(reviewDiffIsStaged(git(empty[0]), file, empty), false);
    });
    test("history and malformed metadata never masquerade as the working deletion pair", () => {
        assert.strictEqual(reviewDiffIsStaged(git("old-commit"), git(empty[0]), empty), true);
        assert.strictEqual(reviewDiffIsStaged({ scheme: "git", query: "not-json" }, git(empty[0]), empty), true);
        assert.strictEqual(reviewDiffIsStaged(git("~"), { scheme: "git", query: "null" }, empty), true);
    });
});
