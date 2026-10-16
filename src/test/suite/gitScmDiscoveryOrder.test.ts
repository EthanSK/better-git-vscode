import * as assert from "assert";
import { repositoriesInScmRegistrationOrder } from "../../gitScmDiscoveryOrder";

const repo = (root: string) => ({ rootUri: { toString: () => root } });
const registered = (root: string, handle: number) => ({ sourceControl: { rootUri: repo(root).rootUri, handle } });

suite("SCM discovery order before Better Git activation", () => {
    test("repairs an API snapshot reordered before activation, without mutating either input", () => {
        const main = repo("main"), target = repo("aimvs11"), longer = repo("a-longer-worktree");
        const snapshot = [longer, target, main];
        const native = [registered("a-longer-worktree", 8), registered("aimvs11", 4), registered("main", 0)];
        const result = repositoriesInScmRegistrationOrder(snapshot, { model: { repositories: native } });
        assert.deepStrictEqual(result, [main, target, longer]);
        assert.deepStrictEqual(snapshot, [longer, target, main]);
        assert.deepStrictEqual(native.map(item => item.sourceControl.handle), [8, 4, 0]);
    });
    test("registration handle gaps and different API wrappers do not alter root order", () => {
        const snapshot = [repo("third"), repo("first"), repo("second")];
        const result = repositoriesInScmRegistrationOrder(snapshot, { model: {
            repositories: [registered("second", 21), registered("third", 47), registered("first", 2)]
        } });
        assert.deepStrictEqual(result.map(item => item.rootUri.toString()), ["first", "second", "third"]);
    });
    test("closed repositories are excluded, reopened roots use their new registration", () => {
        const snapshot = [repo("reopened"), repo("retained")];
        assert.deepStrictEqual(repositoriesInScmRegistrationOrder(snapshot, { model: {
            repositories: [registered("closed", 0), registered("reopened", 20), registered("retained", 3)]
        } }).map(item => item.rootUri.toString()), ["retained", "reopened"]);
    });
    test("missing or changed Git internals retain the existing snapshot", () => {
        const snapshot = [repo("second"), repo("first")];
        for (const exports of [undefined, {}, { model: {} }, { model: { repositories: [] } },
            { model: { repositories: [registered("first", 0)] } }]) {
            assert.deepStrictEqual(repositoriesInScmRegistrationOrder(snapshot, exports), snapshot);
        }
    });
    test("invalid or ambiguous registration data cannot partially reorder the snapshot", () => {
        const snapshot = [repo("second"), repo("first")];
        for (const native of [
            [registered("first", 0), registered("second", 0)],
            [registered("first", 0), registered("first", 1), registered("second", 2)],
            [registered("first", -1), registered("second", 1)],
            [registered("first", 1.5), registered("second", 1)]
        ]) {
            assert.deepStrictEqual(repositoriesInScmRegistrationOrder(snapshot, { model: { repositories: native } }), snapshot);
        }
    });
    test("a throwing compatibility getter falls back without breaking activation", () => {
        const snapshot = [repo("second"), repo("first")];
        assert.deepStrictEqual(repositoriesInScmRegistrationOrder(snapshot, {
            get model() { throw new Error("unsupported"); }
        }), snapshot);
    });
});
