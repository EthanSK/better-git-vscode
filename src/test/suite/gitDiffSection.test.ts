import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { extractFileDiffSection } from "../../gitDiffSection";

suite("Git diff file sections", () => {
    test("finds real Git diffs for spaces, non-ASCII names and escaped control characters", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgv-diff-paths-"));
        const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
        const names = ["normal.txt", "file name.txt", "é.txt", 'quote"tab\t.txt', "back\\slash.txt"];
        try {
            git("init", "-q");
            git("config", "user.name", "Test");
            git("config", "user.email", "test@example.invalid");
            git("config", "commit.gpgsign", "false");
            for (const name of names) { fs.writeFileSync(path.join(root, name), "old\n"); }
            git("add", ".");
            git("commit", "-qm", "base");
            for (const [index, name] of names.entries()) {
                fs.writeFileSync(path.join(root, name), `new ${index}\n`);
            }
            for (const quotePath of ["true", "false"]) {
                const diff = git("-c", `core.quotePath=${quotePath}`, "diff");
                for (const [index, name] of names.entries()) {
                    const section = extractFileDiffSection(diff, name);
                    assert.ok(section.includes(`+new ${index}`), `Missing ${JSON.stringify(name)} with quotePath=${quotePath}`);
                    assert.strictEqual((section.match(/^diff --git /gm) ?? []).length, 1);
                }
            }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test("ignores header-like added content in a different file", () => {
        const diff = "diff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n+++ b/target\n";
        assert.strictEqual(extractFileDiffSection(diff, "target"), "");
    });
});
