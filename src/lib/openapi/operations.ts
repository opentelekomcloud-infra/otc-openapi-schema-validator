import type { NativeOpenApiDocument, NativeOperation } from "@/types/openapi";
import { appendPointer, isRecord, jsonPointer, resolveObjectReference } from "./references";
import { collectDocumentPathEntries } from "./paths";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

export function collectDocumentOperations(
    document: unknown, configuredMethods?: readonly string[], pathFilter?: (path: string) => boolean,
): NativeOperation[] {
    if (!isRecord(document) || !isRecord(document.paths)) return [];
    const allowed = configuredMethods && new Set(configuredMethods.map((method) => method.toLowerCase()));
    if (allowed?.size === 0) return [];
    const supportsTrace = typeof document.openapi === "string" && /^3\.0\./.test(document.openapi);
    const cache = new Map<string, unknown>();
    const result: NativeOperation[] = [];

    for (const [path, rawPathItem] of collectDocumentPathEntries(document)) {
        if (pathFilter && !pathFilter(path)) continue;
        const pathItemPointer = jsonPointer(["paths", path]);
        const resolved = resolveObjectReference(rawPathItem, document, cache, pathItemPointer, "reject");
        if (!resolved) continue;
        const pathItem = resolved.value;
        for (const [key, operation] of Object.entries(pathItem)) {
            const method = key.toLowerCase();
            if (!HTTP_METHODS.has(method) || (method === "trace" && !supportsTrace)) continue;
            if (allowed && !allowed.has(method)) continue;
            if (!isRecord(operation)) continue;
            result.push({
                path, method, pathItem, operation, rawPathItem, pathItemPointer,
                resolvedPathItemPointer: resolved.pointer,
                pointer: appendPointer(resolved.pointer, key),
            });
        }
    }
    return result;
}

export function collectNativeOperations(
    native: NativeOpenApiDocument, configuredMethods?: readonly string[], pathFilter?: (path: string) => boolean,
): NativeOperation[] {
    return collectDocumentOperations(native.document, configuredMethods, pathFilter);
}
