import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
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

async function waitForZoom(expected: number): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (vscode.workspace.getConfiguration("window").get<number>("zoomLevel") === expected) { return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(vscode.workspace.getConfiguration("window").get<number>("zoomLevel"), expected);
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

    test("switches zoom with the selected display, but preserves manual zoom until the next change", async () => {
        const display = (await probeDisplays()).find((candidate) => !candidate.builtIn);
        assert.ok(display, "Mini must have an external display");
        const betterGit = vscode.workspace.getConfiguration("better-git-vscode");
        const window = vscode.workspace.getConfiguration("window");
        const originalTarget = betterGit.inspect<unknown>("inlineDiffOnDisplay")?.globalValue;
        const originalLevels = betterGit.inspect<unknown>("zoomLevelOnDisplay")?.globalValue;
        const originalZoom = window.inspect<number>("zoomLevel")?.globalValue;
        const originalSideBySide = vscode.workspace.getConfiguration("diffEditor")
            .inspect<boolean>("renderSideBySide")?.globalValue;
        const originalNarrow = vscode.workspace.getConfiguration("diffEditor")
            .inspect<boolean>("useInlineViewWhenSpaceIsLimited")?.globalValue;
        const extension = vscode.extensions.getExtension("ethansk.better-git-vscode");
        assert.ok(extension);
        await extension.activate();
        try {
            await betterGit.update("zoomLevelOnDisplay", { connected: 1, disconnected: -2 },
                vscode.ConfigurationTarget.Global);
            await betterGit.update("inlineDiffOnDisplay", display, vscode.ConfigurationTarget.Global);
            await waitForZoom(1);

            await betterGit.update("inlineDiffOnDisplay", {
                uuid: "00000000-0000-0000-0000-000000000000", width: 1, height: 1,
            }, vscode.ConfigurationTarget.Global);
            await waitForZoom(-2);

            await window.update("zoomLevel", -1, vscode.ConfigurationTarget.Global);
            await new Promise((resolve) => setTimeout(resolve, 5500));
            assert.strictEqual(vscode.workspace.getConfiguration("window").get<number>("zoomLevel"), -1,
                "manual zoom must survive the next display check");

            await betterGit.update("inlineDiffOnDisplay", display, vscode.ConfigurationTarget.Global);
            await waitForZoom(1);

            await betterGit.update("zoomLevelOnDisplay", {}, vscode.ConfigurationTarget.Global);
            await window.update("zoomLevel", -3, vscode.ConfigurationTarget.Global);
            await new Promise((resolve) => setTimeout(resolve, 5500));
            assert.strictEqual(vscode.workspace.getConfiguration("window").get<number>("zoomLevel"), -3,
                "disabled zoom switching must leave manual zoom alone");
        } finally {
            await betterGit.update("zoomLevelOnDisplay", originalLevels, vscode.ConfigurationTarget.Global);
            await betterGit.update("inlineDiffOnDisplay", originalTarget, vscode.ConfigurationTarget.Global);
            await window.update("zoomLevel", originalZoom, vscode.ConfigurationTarget.Global);
            await vscode.workspace.getConfiguration("diffEditor").update("renderSideBySide", originalSideBySide,
                vscode.ConfigurationTarget.Global);
            await vscode.workspace.getConfiguration("diffEditor").update("useInlineViewWhenSpaceIsLimited", originalNarrow,
                vscode.ConfigurationTarget.Global);
        }
    });

    for (const mode of ["sideBySide", "inline"] as const) {
        test(`keeps a native ${mode} choice through polling, another diff and a display change`, async () => {
            const display = (await probeDisplays()).find((candidate) => !candidate.builtIn);
            assert.ok(display, "Mini must have an external display");
            const absent = { uuid: "00000000-0000-0000-0000-000000000000", width: 1, height: 1 };
            const config = vscode.workspace.getConfiguration();
            const update = (key: string, value: unknown) => config.update(key, value, vscode.ConfigurationTarget.Global);
            const originals = [
                "better-git-vscode.inlineDiffOnDisplay", "better-git-vscode.zoomLevelOnDisplay",
                "diffEditor.renderSideBySide", "diffEditor.useInlineViewWhenSpaceIsLimited",
                "diffEditor.renderSideBySideInlineBreakpoint", "window.zoomLevel",
            ].map(key => ({ key, value: config.inspect(key)?.globalValue }));
            const folder = await fs.mkdtemp(path.join(os.tmpdir(), "bgv-display-diff-"));
            const openDiff = async (name: string) => {
                const before = path.join(folder, `${name}-before.txt`);
                const after = path.join(folder, `${name}-after.txt`);
                await fs.writeFile(before, "before\n");
                await fs.writeFile(after, "after\n");
                await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(before), vscode.Uri.file(after));
            };
            const sideBySide = mode === "sideBySide";
            const assertLayout = async () => {
                assert.strictEqual(vscode.workspace.getConfiguration("diffEditor").get("renderSideBySide"), sideBySide);
                assert.strictEqual(vscode.workspace.getConfiguration("diffEditor").get("useInlineViewWhenSpaceIsLimited"),
                    !sideBySide, "explicit Side by Side must disable the narrow-editor fallback");
            };
            try {
                await update("diffEditor.renderSideBySideInlineBreakpoint", 10_000);
                await update("better-git-vscode.zoomLevelOnDisplay", { connected: 1, disconnected: -1 });
                await update("better-git-vscode.inlineDiffOnDisplay", sideBySide ? display : absent);
                await waitForSetting("renderSideBySide", !sideBySide);
                await waitForSetting("useInlineViewWhenSpaceIsLimited", true);
                await waitForZoom(sideBySide ? 1 : -1);
                await openDiff("first");
                await vscode.commands.executeCommand(`diffEditor.setViewMode.${mode}`);
                await assertLayout();
                await openDiff("second");
                await new Promise(resolve => setTimeout(resolve, 5500)); // Cross a real five-second reconciliation.
                await assertLayout();

                await update("better-git-vscode.inlineDiffOnDisplay", sideBySide ? absent : display);
                await waitForZoom(sideBySide ? -1 : 1);
                await assertLayout();
                // Zoom proves the check ran. Returning to the original display would undo an unlatched choice.
                await update("better-git-vscode.inlineDiffOnDisplay", sideBySide ? display : absent);
                await waitForZoom(sideBySide ? 1 : -1);
                await assertLayout();
            } finally {
                await update("better-git-vscode.inlineDiffOnDisplay", {});
                for (const { key, value } of originals.slice(1)) { await update(key, value); }
                await update(originals[0].key, originals[0].value);
                await fs.rm(folder, { recursive: true, force: true });
            }
        });
    }
});
