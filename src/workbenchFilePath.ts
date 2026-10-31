// Decode VS Code Copy Path's home label for resource-less media previews; extension.ts owns clipboard access.
import * as path from "path";

/** Convert Copy Path's home label back to a path, without rewriting real URI resources. */
export const resolveWorkbenchFilePath = (copiedPath: string, homeDirectory: string): string => {
    // Ethan: deleted files must receive the same fire/eyes/staging behavior as other changes. Some image
    // tabs expose no resource, so we ask VS Code's Copy Path command. Its label service abbreviates home
    // as ~/ even for Copy Path: Uri.file("~/Projects/...") becomes /~/Projects/... and silently fails the
    // exact Git-membership check. Expand only this display-label prefix, once at the clipboard boundary;
    // never require a working file to exist (a deletion has none), guess a repo, or change Git-side identity.
    if (copiedPath === "~") { return homeDirectory; }
    if (copiedPath.startsWith("~/") || (path.sep === "\\" && copiedPath.startsWith("~\\"))) {
        return path.join(homeDirectory, copiedPath.slice(2));
    }
    return copiedPath;
};
