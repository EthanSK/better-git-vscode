export const isTransientGitIndexLockError = (error: unknown): boolean => {
    const candidate = error as { message?: unknown; stderr?: unknown };
    const text = [candidate?.message, candidate?.stderr]
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .toLowerCase();
    return text.includes("index.lock") && (
        text.includes("file exists") ||
        text.includes("another git process") ||
        text.includes("unable to create")
    );
};

export const runWithTransientGitIndexRetry = async <T>(
    operation: () => Promise<T>,
    wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxAttempts = 6
): Promise<T> => {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error("maxAttempts must be a positive integer");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isTransientGitIndexLockError(error) || attempt === maxAttempts) {
                throw error;
            }
            await wait(80 * attempt);
        }
    }
    throw lastError;
};
