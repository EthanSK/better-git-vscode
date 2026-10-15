import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const scheme = "better-git-staged-image";
const workingScheme = "better-git-working-image";
const maxImageBytes = 50 * 1024 * 1024;
const imageExtensions = new Set([".jpg", ".jpe", ".jpeg", ".png", ".bmp", ".gif", ".ico", ".webp", ".avif", ".svg"]);
const lfsPointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize ([0-9]+)\r?\n?$/;

type StoredImage = { mediaDir: string; oid: string; size: number };

const parseStoredImage = (uri: vscode.Uri): StoredImage => {
    if (uri.scheme !== scheme && uri.scheme !== workingScheme) { throw vscode.FileSystemError.FileNotFound(uri); }
    try {
        const value = JSON.parse(uri.query) as StoredImage;
        if (!path.isAbsolute(value.mediaDir) || !/^[a-f0-9]{64}$/.test(value.oid)
            || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxImageBytes) {
            throw new Error("Invalid staged image");
        }
        return value;
    } catch {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
};

const objectPath = ({ mediaDir, oid }: StoredImage): string =>
    path.join(mediaDir, oid.slice(0, 2), oid.slice(2, 4), oid);

class StagedLfsImageProvider implements vscode.FileSystemProvider {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changeEmitter.event;

    watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const image = parseStoredImage(uri);
        try {
            const stat = await fs.stat(objectPath(image));
            if (!stat.isFile() || stat.size !== image.size) { throw new Error("Missing staged image"); }
            return { type: vscode.FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const image = parseStoredImage(uri);
        try {
            const bytes = await fs.readFile(objectPath(image));
            if (bytes.length !== image.size || createHash("sha256").update(bytes).digest("hex") !== image.oid) {
                throw new Error("Invalid staged image bytes");
            }
            return bytes;
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }
    readDirectory(): [string, vscode.FileType][] { return []; }
    createDirectory(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
    writeFile(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
    delete(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
    rename(uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions(uri); }
    dispose(): void { this.changeEmitter.dispose(); }
}

const mediaDirs = new Map<string, string>();
const localMediaDir = async (root: string): Promise<string | undefined> => {
    const cached = mediaDirs.get(root);
    if (cached) { return cached; }
    try {
        const { stdout } = await execFileAsync("git", ["lfs", "env"], {
            cwd: root, timeout: 2000, maxBuffer: 128 * 1024,
        });
        const mediaDir = /^LocalMediaDir=(.+)$/m.exec(stdout)?.[1]?.trim();
        if (mediaDir && path.isAbsolute(mediaDir)) {
            mediaDirs.set(root, mediaDir);
            return mediaDir;
        }
    } catch { /* Git LFS is unavailable; keep the native preview. */ }
    return undefined;
};

// Resolve each side independently: a working pointer can name different bytes from the index pointer.
// Keep the schemes distinct so review/stage commands never mistake a working preview for staged content.
export const resolveLfsImage = async (gitUri: vscode.Uri, repositoryRoot: string): Promise<vscode.Uri> => {
    if ((gitUri.scheme !== "git" && gitUri.scheme !== "file")
        || !imageExtensions.has(path.extname(gitUri.path).toLowerCase())) {
        return gitUri;
    }
    try {
        if (gitUri.scheme === "file" && vscode.workspace.textDocuments.some(document =>
            document.isDirty && document.uri.toString() === gitUri.toString())) { return gitUri; }
        const stat = await vscode.workspace.fs.stat(gitUri);
        if (stat.size < 100 || stat.size > 1024) { return gitUri; }
        const pointer = Buffer.from(await vscode.workspace.fs.readFile(gitUri)).toString("utf8");
        const match = lfsPointer.exec(pointer);
        if (!match) { return gitUri; }
        const size = Number(match[2]);
        if (!Number.isSafeInteger(size) || size < 1 || size > maxImageBytes) { return gitUri; }
        const mediaDir = await localMediaDir(repositoryRoot);
        if (!mediaDir) { return gitUri; }
        const stored: StoredImage = { mediaDir, oid: match[1], size };
        const object = await fs.stat(objectPath(stored));
        if (!object.isFile() || object.size !== size) { return gitUri; }
        return gitUri.with({ scheme: gitUri.scheme === "file" ? workingScheme : scheme, query: JSON.stringify(stored) });
    } catch {
        return gitUri;
    }
};

export const registerStagedLfsImageProvider = (context: vscode.ExtensionContext): void => {
    const provider = new StagedLfsImageProvider();
    context.subscriptions.push(provider,
        vscode.workspace.registerFileSystemProvider(scheme, provider, { isReadonly: true }),
        vscode.workspace.registerFileSystemProvider(workingScheme, provider, { isReadonly: true }));

    // Native Source Control clicks bypass Better Git navigation. Pointer-only working files can also
    // open as text or a text diff. Replace only clean, active image-pointer tabs, never a dirty editor.
    const resolving = new WeakSet<vscode.Tab>();
    const revealNativeLfsImage = async (): Promise<void> => {
        const group = vscode.window.tabGroups.activeTabGroup;
        const tab = group.activeTab;
        const input = tab?.input;
        if (!tab || tab.isDirty || resolving.has(tab)) {
            return;
        }
        const diff = input instanceof vscode.TabInputTextDiff ? input : undefined;
        const resource = diff?.modified ?? (input instanceof vscode.TabInputText ? input.uri
            : input instanceof vscode.TabInputCustom && input.viewType === "imagePreview.previewEditor" ? input.uri : undefined);
        if (!resource || !["file", "git"].includes(resource.scheme)
            || !imageExtensions.has(path.extname(resource.path).toLowerCase())) { return; }
        let filePath = resource.fsPath;
        if (resource.scheme === "git") {
            try {
                const query = JSON.parse(resource.query);
                if (query?.ref !== "" || typeof query.path !== "string" || !path.isAbsolute(query.path)) { return; }
                filePath = query.path;
            } catch { return; }
        }
        resolving.add(tab);
        try {
            const git = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
            const root: string | undefined = git?.getRepository(vscode.Uri.file(filePath))?.rootUri?.fsPath;
            if (!root) { return; }
            const [resolved, original] = await Promise.all([
                resolveLfsImage(resource, root),
                diff ? resolveLfsImage(diff.original, root) : undefined,
            ]);
            if (resolved === resource && (!diff || original === diff.original)) { return; }
            if (vscode.window.tabGroups.activeTabGroup !== group || group.activeTab !== tab || tab.isDirty) { return; }
            const options = { viewColumn: group.viewColumn, preview: tab.isPreview };
            if (diff && original) {
                await vscode.commands.executeCommand("vscode.diff", original, resolved, tab.label, options);
            } else {
                await vscode.commands.executeCommand("vscode.openWith", resolved, "imagePreview.previewEditor", options);
            }
            // A pinned source tab remains alongside the replacement. Close only that captured tab,
            // after the new preview is active, so no unrelated editor is briefly selected.
            if (group.tabs.includes(tab) && group.activeTab !== tab) {
                await vscode.window.tabGroups.close(tab, true);
            }
        } catch (error) {
            console.warn("Better Git could not preview the local LFS image", error);
        } finally {
            // A later tab activation may retry if Git/LFS was still loading or the object has since arrived.
            resolving.delete(tab);
        }
    };
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { void revealNativeLfsImage(); }));
    void revealNativeLfsImage();
};
