import type {
    NativeOpenApiDocument, NativeOperation, NativeParameter, NativeParameterSchema,
} from "@/types/openapi";
import { isSwagger2Root } from "./media";
import {
    appendPointer, isRecord, resolveObjectReference, type ReferenceCache,
} from "./references";

interface EffectiveParameterNode {
    readonly raw: unknown;
    readonly parameter: Record<string, unknown>;
    readonly level: "path" | "operation";
    readonly index: number;
    readonly pointer: string;
    readonly resolvedPointer: string;
}

export function collectEffectiveParameterNodes(
    pathItem: unknown, operation: unknown, document: unknown, cache: ReferenceCache = new Map(),
    pointers?: { readonly pathItem: string; readonly operation: string },
): EffectiveParameterNode[] {
    const effective = new Map<string, EffectiveParameterNode>();
    const sources = [
        { level: "path" as const, parent: pathItem },
        { level: "operation" as const, parent: operation },
    ];
    for (const { level, parent } of sources) {
        if (!isRecord(parent) || !Array.isArray(parent.parameters)) continue;
        parent.parameters.forEach((raw: unknown, index: number) => {
            const parentPointer = level === "path" ? pointers?.pathItem : pointers?.operation;
            const pointer = appendPointer(parentPointer ?? "#", "parameters", index);
            const resolved = resolveObjectReference(raw, document, cache, pointer);
            if (!resolved) return;
            const value = resolved.value;
            const name = typeof value.name === "string" ? value.name : "";
            const location = typeof value.in === "string" ? value.in : "";
            if (!name || !location) return;
            effective.set(JSON.stringify([location, name]), {
                raw, parameter: value, level, index, pointer, resolvedPointer: resolved.pointer,
            });
        });
    }
    return Array.from(effective.values());
}

export function getParameterSchema(
    parameter: unknown, document: unknown, cache: ReferenceCache = new Map(), pointer = "#",
): NativeParameterSchema | undefined {
    const resolved = resolveObjectReference(parameter, document, cache, pointer);
    if (!resolved) return undefined;
    const node = resolved.value;
    const swagger2 = isSwagger2Root(document);
    if (swagger2 && node.in !== "body") {
        return { node, pointer: resolved.pointer };
    }
    let schema = node.schema;
    let schemaPointer = appendPointer(resolved.pointer, "schema");
    if (schema === undefined && !swagger2 && isRecord(node.content)) {
        const mediaType = ["application/json", "application/xml", ...Object.keys(node.content)]
            .find((key) => Object.prototype.hasOwnProperty.call(node.content, key));
        if (mediaType !== undefined) {
            const media = node.content[mediaType];
            if (isRecord(media)) {
                schema = media.schema;
                schemaPointer = appendPointer(resolved.pointer, "content", mediaType, "schema");
            }
        }
    }
    if (schema === undefined) return undefined;
    const target = resolveObjectReference(schema, document, cache, schemaPointer);
    if (!target) return undefined;
    return { node: target.value, pointer: target.pointer };
}

export function collectParameterDescriptors(
    pathItem: unknown, operation: unknown, document: unknown, cache: ReferenceCache = new Map(),
    pointers?: { readonly pathItem: string; readonly operation: string },
): NativeParameter[] {
    const swagger2 = isSwagger2Root(document);
    return collectEffectiveParameterNodes(pathItem, operation, document, cache, pointers)
        .map(({ raw, parameter, level, index, pointer, resolvedPointer }) => {
            const location = String(parameter.in);
            return {
                raw, parameter, level, index, pointer, resolvedPointer,
                name: String(parameter.name), location, required: parameter.required === true,
                kind: swagger2 && location === "body" ? "body"
                    : swagger2 && location === "formData" ? "formData" : "parameter",
                schema: getParameterSchema(parameter, document, cache, resolvedPointer),
                style: parameter.style,
                explode: parameter.explode,
                collectionFormat: parameter.collectionFormat,
            };
        });
}

export function collectNativeParameters(
    native: NativeOpenApiDocument, operation: NativeOperation, cache: ReferenceCache = new Map(),
): NativeParameter[] {
    return collectParameterDescriptors(operation.pathItem, operation.operation, native.document, cache, {
        pathItem: operation.resolvedPathItemPointer, operation: operation.pointer,
    });
}
