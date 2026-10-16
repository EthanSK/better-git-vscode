interface RepositoryRoot {
    rootUri: { toString(): string };
}

/**
 * Git's API repository array can already be sorted by path length when we
 * activate. Its SCM registration handles retain the actual creation order.
 * This optional adapter only seeds our existing open/close-event ordering;
 * native selection still verifies the exact root before any group operation.
 */
export const repositoriesInScmRegistrationOrder = <T extends RepositoryRoot>(
    repositories: readonly T[], gitExports: unknown
): T[] => {
    const fallback = [...repositories];
    try {
        // The exported Git model is not part of API v1. Treat it as an optional
        // compatibility hint, never mutate it or depend on its availability.
        const native = (gitExports as { model?: { repositories?: unknown } } | undefined)?.model?.repositories;
        if (!Array.isArray(native)) { return fallback; }
        const handles = new Map<string, number>();
        const usedHandles = new Set<number>();
        for (const repository of native) {
            const sourceControl = repository?.sourceControl;
            const handle = sourceControl?.handle;
            if (!Number.isSafeInteger(handle) || handle < 0 || !sourceControl?.rootUri) { continue; }
            const root = sourceControl.rootUri.toString();
            if (handles.has(root) || usedHandles.has(handle)) { return fallback; }
            handles.set(root, handle);
            usedHandles.add(handle);
        }
        // Never invent a relative position for an unmapped provider.
        if (!fallback.every(repository => handles.has(repository.rootUri.toString()))) { return fallback; }
        return fallback.sort((left, right) => handles.get(left.rootUri.toString())!
            - handles.get(right.rootUri.toString())!);
    } catch {
        return fallback;
    }
};
