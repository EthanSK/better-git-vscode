import * as assert from 'assert';
import * as path from 'path';
import { createWorktreeLink, parseWorktreeLink, worktreeLinkReturnApp } from '../../gitWorktreeLink';

const parse = (value: string) => {
    const outer = new URL(value);
    const uri = outer.origin === "https://vscode.dev" ? new URL(decodeURIComponent(outer.searchParams.get("url")!)) : outer;
    return parseWorktreeLink({ authority: uri.hostname, path: uri.pathname, query: uri.search.slice(1), fragment: uri.hash.slice(1) });
};
suite('Git worktree links', () => {
    test('published return settings default off and cannot be enabled by a workspace', () => {
        const properties = require('../../../package.json').contributes.configuration.properties;
        assert.strictEqual(properties['better-git-vscode.worktreeLinkReturnFocus'].default, false);
        assert.strictEqual(properties['better-git-vscode.worktreeLinkReturnApp'].default, '');
        assert.strictEqual(properties['better-git-vscode.worktreeLinkReturnFocus'].scope, 'application');
        assert.strictEqual(properties['better-git-vscode.worktreeLinkKeepEditorFront'].default, false);
        assert.strictEqual(properties['better-git-vscode.worktreeLinkKeepEditorFront'].scope, 'application');
        assert.strictEqual(properties['better-git-vscode.worktreeLinkReturnApp'].scope, 'application');
    });

    test('return focus defaults off even for explicit legacy Codex metadata', () => {
        const link = { authority: 'ethansk.better-git-vscode', path: '/open-worktree', fragment: '', query: 'path=%2Ftmp%2Frepo&returnTo=codex' };
        assert.strictEqual(worktreeLinkReturnApp(link, false, 'com.apple.TextEdit'), undefined);
        assert.strictEqual(worktreeLinkReturnApp(link, true), 'com.openai.codex');
    });
    test('link app overrides the local fallback and survives both redirect encoding layers', () => {
        const outer = new URL(createWorktreeLink(path.resolve('work + 100% # & 日本'), 'vscode', 'com.apple.TextEdit'));
        const inner = new URL(decodeURIComponent(outer.searchParams.get('url')!));
        const link = { authority: inner.hostname, path: inner.pathname, fragment: '', query: inner.search.slice(1) };
        assert.strictEqual(worktreeLinkReturnApp(link, true, 'com.openai.codex'), 'com.apple.TextEdit');
        assert.strictEqual(parse(outer.href), path.resolve('work + 100% # & 日本'));
        assert.strictEqual(new URL(decodeURIComponent(new URL(createWorktreeLink('/tmp/repo')).searchParams.get('url')!)).searchParams.has('returnTo'), false);
    });
    test('only missing metadata uses the configured app; invalid metadata never falls back', () => {
        const base = { authority: 'ethansk.better-git-vscode', path: '/open-worktree', fragment: '', query: 'path=%2Ftmp%2Frepo' };
        assert.strictEqual(worktreeLinkReturnApp(base, true, 'com.openai.codex'), 'com.openai.codex');
        assert.strictEqual(worktreeLinkReturnApp(base, true), undefined);
        for (const suffix of ['&returnTo=', '&returnTo=chrome', '&returnTo=Codex', '&returnTo=codex&returnTo=codex', '&returnTo=com.apple.TextEdit&returnTo=codex', '&returnTo=%2FApplications%2FCode.app', '&returnTo=app%3A%2F%2Fx', '&returnTo=com.apple.TextEdit%0A', '&returnTo=%24%28touch%20bad%29']) {
            assert.strictEqual(worktreeLinkReturnApp({ ...base, query: base.query + suffix }, true, 'com.openai.codex'), undefined, suffix);
        }
        assert.strictEqual(worktreeLinkReturnApp({ ...base, query: 'path=relative&returnTo=codex' }, true), undefined);
    });
    test('preserves spaces, unicode, plus, percent and URL punctuation exactly once', () => {
        const root = path.resolve("work tree ) ' + 100% # ? & 日本 %2F");
        assert.strictEqual(new URL(createWorktreeLink(root)).origin, 'https://vscode.dev');
        assert.ok(!/[()']/.test(createWorktreeLink(root)));
        assert.strictEqual(parse(createWorktreeLink(root)), root);
        assert.strictEqual(parse(createWorktreeLink(root, 'vscode-insiders')), root);
        // Microsoft's live redirect appends its original url query as metadata.
        const redirect = new URL(decodeURIComponent(new URL(createWorktreeLink(root)).searchParams.get('url')!));
        redirect.searchParams.set('url', new URL(createWorktreeLink(root)).searchParams.get('url')!);
        assert.strictEqual(parse(redirect.href), root);
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
