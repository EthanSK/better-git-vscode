import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { runInNewContext } from 'vm';

// Exercise the production resolver/provider against real files, Git index blobs and custom LFS storage.
// Only VS Code's host boundary is substituted; no GUI or Extension Development Host is launched.
suite('Local LFS image references', () => {
    class Uri {
        constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
        get fsPath() { return this.path; }
        static file(filePath: string) { return new Uri('file', filePath); }
        with(value: { scheme?: string; query?: string }) {
            return new Uri(value.scheme ?? this.scheme, this.path, value.query ?? this.query);
        }
        toString() { return `${this.scheme}:${this.path}?${this.query}`; }
    }
    class TabInputText { constructor(readonly uri: Uri) {} }
    class TabInputCustom { constructor(readonly uri: Uri, readonly viewType: string) {} }
    class TabInputTextDiff { constructor(readonly original: Uri, readonly modified: Uri) {} }
    let root: string;
    let storage: string;
    let source: string;
    let api: any;
    let host: any;
    let group: any;
    let context: any;
    let onTabs: () => void;
    let commands: any[][];
    let providers: Map<string, any>;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
    const oid = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const pointer = (bytes: Buffer) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid(bytes)}\nsize ${bytes.length}\n`;
    const store = async (bytes: Buffer) => {
        const hash = oid(bytes);
        const file = path.join(storage, 'objects', hash.slice(0, 2), hash.slice(2, 4), hash);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
        return file;
    };
    const until = async (predicate: () => boolean) => {
        for (let n = 0; n < 100; n++) {
            if (predicate()) { return; }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('LFS preview did not settle');
    };
    suiteSetup(async () => {
        source = await fs.readFile(path.resolve(__dirname, '../../stagedLfsImage.js'), 'utf8');
    });
    setup(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgv-lfs-reference-'));
        storage = path.join(root, 'custom-lfs');
        git('init', '-q');
        git('config', 'lfs.storage', storage);
        group = { activeTab: undefined, tabs: [], viewColumn: 1 };
        commands = [];
        providers = new Map();
        context = { subscriptions: [] };
        host = {
            Uri, TabInputText, TabInputCustom, TabInputTextDiff,
            Disposable: class { dispose() {} },
            EventEmitter: class { event = () => undefined; dispose() {} },
            FileType: { File: 1 },
            FileSystemError: { FileNotFound: () => new Error('FileNotFound'), NoPermissions: () => new Error('NoPermissions') },
            extensions: { getExtension: () => ({ exports: { getAPI: () => ({ getRepository: () => ({ rootUri: Uri.file(root) }) }) } }) },
            workspace: {
                textDocuments: [],
                fs: {
                    stat: async (uri: Uri) => ({ size: (await readResource(uri)).length }),
                    readFile: (uri: Uri) => readResource(uri),
                },
                registerFileSystemProvider: (scheme: string, provider: any, options: any) => {
                    assert.strictEqual(options.isReadonly, true);
                    providers.set(scheme, provider);
                    return { dispose() {} };
                },
            },
            window: { tabGroups: {
                activeTabGroup: group,
                onDidChangeTabs: (listener: () => void) => { onTabs = listener; return { dispose() {} }; },
                close: async (tab: any) => { group.tabs = group.tabs.filter((item: any) => item !== tab); },
            } },
            commands: { executeCommand: async (...args: any[]) => {
                commands.push(args);
                const replacement = { input: new TabInputCustom(args[1], 'imagePreview.previewEditor') };
                group.tabs.push(replacement);
                group.activeTab = replacement;
            } },
        };
        const readResource = async (uri: Uri): Promise<Buffer> => {
            if (uri.scheme === 'file') { return fs.readFile(uri.fsPath); }
            const query = JSON.parse(uri.query);
            return git('show', `${query.ref}:${path.relative(root, query.path)}`);
        };
        const exports = {};
        runInNewContext('(function(require, exports) {' + source + '\n})', { Buffer, console })(
            (id: string) => id === 'vscode' ? host : require(id), exports);
        api = exports;
        api.registerStagedLfsImageProvider(context);
    });
    teardown(async () => {
        for (const disposable of context.subscriptions) { disposable.dispose(); }
        await fs.rm(root, { recursive: true, force: true });
    });
    test('working and staged references resolve their own bytes without hydrating or editing the index', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        await store(image);
        await fs.writeFile(uri.path, pointer(image));
        git('add', 'image.png');
        const indexBefore = await fs.readFile(path.join(root, '.git/index'));
        const other = Buffer.concat([image, Buffer.from('different working version')]);
        await store(other);
        await fs.writeFile(uri.path, pointer(other));
        const indexUri = uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.path, ref: '' }) });
        const working = await api.resolveLfsImage(uri, root);
        const staged = await api.resolveLfsImage(indexUri, root);
        assert.strictEqual(working.scheme, 'better-git-working-image');
        assert.strictEqual(staged.scheme, 'better-git-staged-image');
        assert.deepStrictEqual(await providers.get(working.scheme).readFile(working), other);
        assert.deepStrictEqual(await providers.get(staged.scheme).readFile(staged), image);
        assert.strictEqual(await fs.readFile(uri.path, 'utf8'), pointer(other));
        assert.deepStrictEqual(await fs.readFile(path.join(root, '.git/index')), indexBefore);
        await assert.rejects(async () => providers.get(working.scheme).writeFile(working), /NoPermissions/);
    });
    test('missing, wrong-sized, malformed and ordinary images retain their original resource', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        await fs.writeFile(uri.path, pointer(image));
        assert.strictEqual(await api.resolveLfsImage(uri, root), uri);
        const object = await store(image);
        await fs.writeFile(object, image.subarray(0, -1));
        assert.strictEqual(await api.resolveLfsImage(uri, root), uri);
        for (const content of [image, Buffer.from(pointer(image).replace('sha256:', 'sha512:'))]) {
            await fs.writeFile(uri.path, content);
            assert.strictEqual(await api.resolveLfsImage(uri, root), uri);
        }
    });
    test('corrupt bytes of the expected length are never rendered', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        const object = await store(image);
        await fs.writeFile(uri.path, pointer(image));
        const resolved = await api.resolveLfsImage(uri, root);
        const corrupt = Buffer.from(image);
        corrupt[0] ^= 1;
        await fs.writeFile(object, corrupt);
        await assert.rejects(providers.get(resolved.scheme).readFile(resolved), /FileNotFound/);
    });
    test('dirty image text remains editable rather than being replaced by the on-disk reference', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        await store(image);
        await fs.writeFile(uri.path, pointer(image));
        host.workspace.textDocuments = [{ uri, isDirty: true }];
        assert.strictEqual(await api.resolveLfsImage(uri, root), uri);
    });
    test('a native working-file text tab reopens as an image and closes only its captured source', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        await store(image);
        await fs.writeFile(uri.path, pointer(image));
        const tab = { input: new TabInputText(uri), isDirty: false, isPreview: true };
        const unrelated = { input: new TabInputText(Uri.file(path.join(root, 'other.ts'))) };
        group.tabs = [unrelated, tab];
        group.activeTab = tab;
        onTabs();
        await until(() => commands.length === 1 && !group.tabs.includes(tab));
        assert.strictEqual(commands[0][0], 'vscode.openWith');
        assert.strictEqual(commands[0][1].scheme, 'better-git-working-image');
        assert.strictEqual(commands[0][2], 'imagePreview.previewEditor');
        assert.ok(group.tabs.includes(unrelated));
        onTabs();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.strictEqual(commands.length, 1, 'resolved image must not reopen in a loop');
    });
    test('a native pointer-text comparison resolves both sides without mixing their bytes', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        await store(image);
        await fs.writeFile(uri.path, pointer(image));
        git('add', 'image.png');
        const other = Buffer.concat([image, Buffer.from('working')]);
        await store(other);
        await fs.writeFile(uri.path, pointer(other));
        const indexUri = uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.path, ref: '' }) });
        const tab = { input: new TabInputTextDiff(indexUri, uri), isDirty: false, isPreview: false, label: 'image.png (Working Tree)' };
        group.tabs = [tab]; group.activeTab = tab;
        onTabs();
        await until(() => commands.length === 1);
        const [command, left, right, title] = commands[0];
        assert.strictEqual(command, 'vscode.diff');
        assert.strictEqual(title, tab.label);
        assert.deepStrictEqual(await providers.get(left.scheme).readFile(left), image);
        assert.deepStrictEqual(await providers.get(right.scheme).readFile(right), other);
    });
    test('switching away or editing while object resolution is pending never steals the editor', async () => {
        const uri = Uri.file(path.join(root, 'image.png'));
        await store(image);
        await fs.writeFile(uri.path, pointer(image));
        for (const cancel of [() => { group.activeTab = undefined; }, () => { group.activeTab.isDirty = true; }]) {
            let release!: () => void;
            const pending = new Promise<void>(resolve => { release = resolve; });
            const readFile = host.workspace.fs.readFile;
            host.workspace.fs.readFile = async (resource: Uri) => { await pending; return readFile(resource); };
            const tab = { input: new TabInputText(uri), isDirty: false, isPreview: true };
            group.tabs = [tab]; group.activeTab = tab;
            onTabs();
            cancel(); release();
            await new Promise(resolve => setTimeout(resolve, 100));
            host.workspace.fs.readFile = readFile;
            assert.strictEqual(commands.length, 0);
        }
    });
});
