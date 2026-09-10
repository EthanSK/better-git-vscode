import * as assert from 'assert';
import * as path from 'path';
import { createWorktreeLink, parseWorktreeLink } from '../../gitWorktreeLink';

const parse = (value: string) => {
    const outer = new URL(value);
    const uri = outer.origin === "https://vscode.dev" ? new URL(decodeURIComponent(outer.searchParams.get("url")!)) : outer;
    return parseWorktreeLink({ authority: uri.hostname, path: uri.pathname, query: uri.search.slice(1), fragment: uri.hash.slice(1) });
};
suite('Git worktree links', () => {
    test('preserves spaces, unicode, plus, percent and URL punctuation exactly once', () => {
        const root = path.resolve("work tree ) ' + 100% # ? & 日本 %2F");
        assert.strictEqual(new URL(createWorktreeLink(root)).origin, 'https://vscode.dev');
        assert.ok(!/[()']/.test(createWorktreeLink(root)));
        assert.strictEqual(parse(createWorktreeLink(root)), root);
        assert.strictEqual(parse(createWorktreeLink(root, 'vscode-insiders')), root);
    });
    test('rejects missing, relative, duplicate, control-character and wrong-route targets', () => {
        for (const value of [
            'vscode://ethansk.better-git-vscode/open-worktree',
            'vscode://ethansk.better-git-vscode/open-worktree?path=relative',
            'vscode://ethansk.better-git-vscode/open-worktree?path=file%3A%2F%2F%2Ftmp%2Frepo',
            'vscode://ethansk.better-git-vscode/open-worktree?path=%2Ftmp%2Fa&path=%2Ftmp%2Fb',
            'vscode://ethansk.better-git-vscode/open-worktree?path=%2Ftmp%2Fa%00',
            'vscode://ethansk.better-git-vscode/open-worktree?path=%2Ftmp%2Fa%0A',
            'vscode://ethansk.better-git-vscode/open-worktree?path=%2Ftmp%2Fa#unexpected',
            'vscode://some.other-extension/open-worktree?path=%2Ftmp%2Fa',
            'vscode://ethansk.better-git-vscode/run-command?path=%2Ftmp%2Fa',
        ]) { assert.strictEqual(parse(value), undefined, value); }
    });
    test('treats shell syntax as path text, never executable instructions', () => {
        const root = path.resolve('$(touch never-execute) `echo test`');
        assert.strictEqual(new URL(createWorktreeLink(root)).origin, 'https://vscode.dev');
        assert.ok(!/[()']/.test(createWorktreeLink(root)));
        assert.strictEqual(parse(createWorktreeLink(root)), root);
    });
});
