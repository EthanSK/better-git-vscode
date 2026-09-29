import * as assert from "assert";
import { parseDisplayZoomLevels } from "../../displayZoomLevels";

suite("Display-aware zoom levels", () => {
    test("accepts finite VS Code zoom levels and keeps zero", () => {
        assert.deepStrictEqual(parseDisplayZoomLevels({ connected: -2, disconnected: 0 }),
            { connected: -2, disconnected: 0 });
        assert.deepStrictEqual(parseDisplayZoomLevels({ connected: 0.5, disconnected: -1 }),
            { connected: 0.5, disconnected: -1 });
    });

    test("ignores incomplete or invalid configuration", () => {
        for (const value of [{}, { connected: -2 }, { connected: "-2", disconnected: -1 },
            { connected: 9, disconnected: -1 }, { connected: -2, disconnected: -9 },
            { connected: NaN, disconnected: 0 }, null, []]) {
            assert.strictEqual(parseDisplayZoomLevels(value), undefined);
        }
    });
});
