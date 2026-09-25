export interface DiffViewDisplayTarget {
    uuid: string;
    width: number;
    height: number;
}

export interface MacDisplay {
    uuid: string;
    width: number;
    height: number;
    builtIn: boolean;
}

export function parseDisplayTarget(value: unknown): DiffViewDisplayTarget | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) { return undefined; }
    const target = value as Partial<DiffViewDisplayTarget>;
    if (typeof target.uuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(target.uuid)
        || !Number.isInteger(target.width) || !Number.isInteger(target.height)
        || target.width! <= 0 || target.height! <= 0) { return undefined; }
    return { uuid: target.uuid.toUpperCase(), width: target.width!, height: target.height! };
}

export function matchDisplay(target: DiffViewDisplayTarget, displays: MacDisplay[]): boolean | undefined {
    const external = displays.filter((display) => !display.builtIn);
    if (external.some((display) => display.uuid.toUpperCase() === target.uuid)) { return true; }
    const sameSize = external.filter((display) => display.width === target.width && display.height === target.height);
    if (sameSize.length === 1) { return true; }
    // Two matching-size displays cannot identify the target safely. Keep the current diff mode.
    return sameSize.length === 0 ? false : undefined;
}
