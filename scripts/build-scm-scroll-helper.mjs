// Build the small macOS AX worker into the extension's existing dist artifact directory.
// Users run the bundled binary; they never need Swift/Xcode installed. Other platforms do not use it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.platform === 'darwin') {
    const dist = fileURLToPath(new URL('../dist/', import.meta.url));
    const source = fileURLToPath(new URL('../src/native/scmReviewScroll.swift', import.meta.url));
    mkdirSync(dist, { recursive: true });
    const slices = ['arm64', 'x86_64'].map(arch => `${dist}/scm-review-scroll-${arch}`);
    try {
        for (const [index, arch] of ['arm64', 'x86_64'].entries()) {
            execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx11.0`, source, '-o', slices[index]], { stdio: 'inherit' });
        }
        execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', `${dist}/scm-review-scroll`]);
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', `${dist}/scm-review-scroll`]);
    } finally { for (const slice of slices) { rmSync(slice, { force: true }); } }
}
