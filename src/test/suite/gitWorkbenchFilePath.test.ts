// Non-GUI coverage for home-shortened paths, including nonexistent deleted files; run through npm test.
import * as assert from "assert";
import * as path from "path";
import { resolveWorkbenchFilePath } from "../../workbenchFilePath";

suite("Workbench review path", () => {
    const home = path.resolve("home", "reviewer");

    test("expands home labels for deleted images without checking for a working file", () => {
        for (const relative of ["Projects/app/deleted.png", "Projects/app/deleted.txt", "Projects/app/space # é%.png"]) {
            assert.strictEqual(resolveWorkbenchFilePath(`~/${relative}`, home), path.join(home, relative));
        }
        assert.strictEqual(resolveWorkbenchFilePath("~", home), home);
    });

    test("preserves absolute paths and literal tildes inside real paths", () => {
        for (const copied of [path.join(home, "Projects/app/image.png"), "/tmp/~literal.png", "/tmp/~/deleted.png",
            "/~/literal-root.png", "~another-user/file.png", "relative/file.png", "", "  /tmp/spaces.png  "]) {
            assert.strictEqual(resolveWorkbenchFilePath(copied, home), copied);
        }
    });

    test("keeps platform-specific separators", () => {
        assert.strictEqual(resolveWorkbenchFilePath("~\\Projects\\deleted.png", home),
            path.sep === "\\" ? path.join(home, "Projects\\deleted.png") : "~\\Projects\\deleted.png");
    });
});
