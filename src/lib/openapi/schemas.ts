import type { NativeOpenApiDocument, NativeSourceNode } from "@/types/openapi";
import { NativeAccessorError } from "./accessorError";
import { hasOwnField } from "./media";
import { appendPointer, isRecord, jsonPointer, resolveObjectReference, type ReferenceCache } from "./references";

export function getNativeSchemas(
    native: NativeOpenApiDocument, cache: ReferenceCache = new Map(),
): readonly (NativeSourceNode & { readonly name: string })[] {
    if (native.dialect === "openapi3" && hasOwnField(native.document, "components") &&
        !isRecord(native.document.components)) {
        throw new NativeAccessorError("INVALID_DECLARATION", "#/components", "Expected a components object");
    }
    const container = native.dialect === "swagger2" ? native.document.definitions
        : isRecord(native.document.components) ? native.document.components.schemas : undefined;
    const pointer = jsonPointer(native.dialect === "swagger2" ? ["definitions"] : ["components", "schemas"]);
    if (container === undefined) return [];
    if (!isRecord(container)) {
        throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a schemas map");
    }
    return Object.entries(container).map(([name, raw]) => {
        const sourcePointer = appendPointer(pointer, name);
        const resolved = resolveObjectReference(raw, native.document, cache, sourcePointer);
        if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", sourcePointer, "Expected a schema object");
        return { name, raw, node: resolved.value, pointer: sourcePointer, resolvedPointer: resolved.pointer };
    });
}
