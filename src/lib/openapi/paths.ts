import { isRecord } from "./references";

export function isPathEntryKey(key: string): boolean {
    return !key.startsWith("x-");
}

export function collectDocumentPathEntries(document: unknown): [string, unknown][] {
    if (!isRecord(document) || !isRecord(document.paths)) return [];
    // Invalid path names still contain authored operations; compliance reports their format.
    return Object.entries(document.paths).filter(([key]) => isPathEntryKey(key));
}
