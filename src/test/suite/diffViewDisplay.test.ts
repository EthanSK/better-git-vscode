import * as assert from "assert";
import * as vscode from "vscode";
import { probeDisplays } from "../../diffViewDisplay";

async function waitForSetting(name: string, expected: boolean): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (vscode.workspace.getConfiguration("diffEditor").get<boolean>(name) === expected) { return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(vscode.workspace.getConfiguration("diffEditor").get<boolean>(name), expected);
}

suite("Display-aware diff view E2E", () => {
    test("updates on connected, disconnected and disabled target without an active diff", async () => {
        const display = (await probeDisplays()).find((candidate) => !candidate.builtIn);
        assert.ok(display, "Mini must have an external display");
        const betterGit = vscode.workspace.getConfiguration("better-git-vscode");
        const diff = vscode.workspace.getConfiguration("diffEditor");
        const originalTarget = betterGit.inspect<unknown>("inlineDiffOnDisplay")?.globalValue;
        const originalSideBySide = diff.inspect<boolean>("renderSideBySide")?.globalValue;
        const originalNarrow = diff.inspect<boolean>("useInlineViewWhenSpaceIsLimited")?.globalValue;
        const extension = vscode.extensions.getExtension("ethansk.better-git-vscode");
        assert.ok(extension);
        await extension.activate();
        try {
            await betterGit.update("inlineDiffOnDisplay", display, vscode.ConfigurationTarget.Global);
            await waitForSetting("renderSideBySide", false);
            await waitForSetting("useInlineViewWhenSpaceIsLimited", true);

            await betterGit.update("inlineDiffOnDisplay", {
                uuid: "00000000-0000-0000-0000-000000000000", width: 1, height: 1,
            }, vscode.ConfigurationTarget.Global);
            await waitForSetting("renderSideBySide", true);

            await betterGit.update("inlineDiffOnDisplay", {}, vscode.ConfigurationTarget.Global);
            await diff.update("renderSideBySide", false, vscode.ConfigurationTarget.Global);
            await new Promise((resolve) => setTimeout(resolve, 5500));
            assert.strictEqual(vscode.workspace.getConfiguration("diffEditor").get<boolean>("renderSideBySide"), false,
                "disabled mode must not manage diff settings");
        } finally {
            await betterGit.update("inlineDiffOnDisplay", originalTarget, vscode.ConfigurationTarget.Global);
            await diff.update("renderSideBySide", originalSideBySide, vscode.ConfigurationTarget.Global);
            await diff.update("useInlineViewWhenSpaceIsLimited", originalNarrow, vscode.ConfigurationTarget.Global);
        }
    });
});
