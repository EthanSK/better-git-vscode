// Git quotes non-ASCII bytes and control characters with C-style escapes. It
// also appends a tab to unquoted ---/+++ paths containing spaces.
const decodeHeaderPath = (header: string): string | undefined => {
    if (!header.startsWith('"')) {
        return header.split("\t", 1)[0];
    }
    const quoted = /^"((?:\\.|[^"\\])*)"(?:\t.*)?$/.exec(header);
    if (!quoted) { return undefined; }
    const bytes: number[] = [];
    const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    const body = quoted[1];
    for (let i = 0; i < body.length;) {
        if (body[i] !== "\\") {
            const character = String.fromCodePoint(body.codePointAt(i)!);
            bytes.push(...Buffer.from(character));
            i += character.length;
            continue;
        }
        i++;
        const octal = /^[0-7]{1,3}/.exec(body.slice(i));
        if (octal) {
            bytes.push(parseInt(octal[0], 8));
            i += octal[0].length;
        } else {
            const escaped = escapes[body[i++]];
            if (escaped === undefined) { return undefined; }
            bytes.push(escaped);
        }
    }
    return Buffer.from(bytes).toString("utf8");
};

export const extractFileDiffSection = (fullDiff: string, relativePath: string): string => {
    const sections = fullDiff.split(/(?=^diff --git )/m);
    for (const section of sections) {
        if (!section.startsWith("diff --git ")) { continue; }
        for (const line of section.split("\n")) {
            if (line.startsWith("@@")) { break; } // added file contents are never path headers
            if (!line.startsWith("--- ") && !line.startsWith("+++ ")) { continue; }
            const decoded = decodeHeaderPath(line.slice(4));
            if (decoded === `a/${relativePath}` || decoded === `b/${relativePath}`) {
                return section.trimEnd();
            }
        }
    }
    return "";
};
