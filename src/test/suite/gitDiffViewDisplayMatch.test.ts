import * as assert from "assert";
import { matchDisplay, parseDisplayTarget } from "../../gitDiffViewDisplayMatch";

const target = parseDisplayTarget({ uuid: "C5BBC625-DA82-4F83-8FDE-E14BE36145AE", width: 3440, height: 1440 })!;
const dell = { uuid: target.uuid, width: 3440, height: 1440, builtIn: false };

suite("Display-aware diff view matching", () => {
    test("disabled and malformed targets cannot change settings", () => {
        for (const value of [{}, null, { uuid: "Dell", width: 3440, height: 1440 },
            { ...target, width: 0 }, { ...target, height: 1440.5 }]) {
            assert.strictEqual(parseDisplayTarget(value), undefined);
        }
    });

    test("exact external ID wins even if its size changes", () => {
        assert.strictEqual(matchDisplay(target, [{ ...dell, width: 2560 }]), true);
        assert.strictEqual(matchDisplay(target, [{ ...dell, builtIn: true }]), false);
    });

    test("a unique matching external size survives an ID change", () => {
        assert.strictEqual(matchDisplay(target, [
            { ...dell, uuid: "NEW" },
            { uuid: "OTHER", width: 1920, height: 1080, builtIn: false },
        ]), true);
        assert.strictEqual(matchDisplay(target, []), false);
    });

    test("ambiguous fallback keeps the existing mode", () => {
        assert.strictEqual(matchDisplay(target, [
            { ...dell, uuid: "OTHER-1" }, { ...dell, uuid: "OTHER-2" },
        ]), undefined);
    });
});
