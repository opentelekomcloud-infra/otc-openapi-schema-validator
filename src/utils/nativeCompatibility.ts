import type {
    NativeOpenApiDocument, NativeOperation, NativeParameterSchema, NativeRequestPayload, NativeResponsePayload,
} from "@/types/openapi";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { collectNativeOperations } from "@/lib/openapi/operations";
import { getNativeRequest, selectPayloadSchema } from "@/lib/openapi/payloads";
import { collectNativeParameters } from "@/lib/openapi/parameters";
import { getEffectiveStringList } from "@/lib/openapi/media";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";
import { rootSchemaFields } from "@/utils/nativeNaming";

export const operationKey = (operation: NativeOperation) => `${operation.method} ${operation.path}`;

export function comparisonOperations(
    native: NativeOpenApiDocument, methods?: readonly string[], paths?: ReadonlySet<string>,
): Map<string, NativeOperation> {
    return new Map(collectNativeOperations(native, methods, paths && ((path) => paths.has(path)))
        .map((operation) => [operationKey(operation), operation]));
}

export function responseCodes(operation: NativeOperation): string[] {
    const responses = operation.operation.responses;
    if (responses === undefined) return [];
    if (!isRecord(responses)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(operation.pointer, "responses"),
            "Expected a responses map");
    }
    return Object.keys(responses).filter((code) => !code.toLowerCase().startsWith("x-"));
}

export function comparisonResponse(
    native: NativeOpenApiDocument, operation: NativeOperation, code: string, cache: ReferenceCache,
) {
    const responses = operation.operation.responses;
    if (!isRecord(responses) || !Object.hasOwn(responses, code)) return undefined;
    const pointer = appendPointer(operation.pointer, "responses", code);
    const resolved = resolveObjectReference(responses[code], native.document, cache, pointer);
    if (!resolved) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a response object");
    return resolved;
}

export function responseHeaders(
    native: NativeOpenApiDocument, operation: NativeOperation, code: string, cache: ReferenceCache,
): Set<string> {
    const response = comparisonResponse(native, operation, code, cache);
    if (!response || response.value.headers === undefined) return new Set();
    if (!isRecord(response.value.headers)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(response.pointer, "headers"),
            "Expected a response headers map");
    }
    return new Set(Object.keys(response.value.headers).map((name) => name.toLowerCase()));
}

export function responseMediaTypes(
    native: NativeOpenApiDocument, operation: NativeOperation, code: string, cache: ReferenceCache,
): ReadonlySet<string> | undefined {
    const response = comparisonResponse(native, operation, code, cache);
    if (!response) return new Set();
    if (native.dialect === "swagger2") {
        if (response.value.schema === undefined) return new Set();
        const media = getEffectiveStringList(native.document, operation.operation, "produces", operation.pointer);
        return media.state === "unspecified" ? undefined : new Set(media.values);
    }
    if (response.value.content === undefined) return new Set();
    if (!isRecord(response.value.content)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(response.pointer, "content"),
            "Expected a response content map");
    }
    return new Set(Object.keys(response.value.content));
}

export interface CompatibilityShape {
    readonly properties: Set<string>;
    readonly types: Map<string, string>;
    readonly enums: Map<string, Set<string>>;
}

function schemaType(
    schema: NativeParameterSchema, native: NativeOpenApiDocument, cache: ReferenceCache, active = new Set<object>(),
): string {
    const resolved = resolveObjectReference(schema.node, native.document, cache, schema.pointer);
    if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", schema.pointer, "Expected a schema object");
    const node = resolved.value;
    if (active.has(node)) return "recursive";
    if (node.type === "array" || (node.type === undefined && node.items !== undefined)) {
        if (!isRecord(node.items)) return "array<unknown>";
        active.add(node);
        const type = `array<${schemaType({ node: node.items, pointer: appendPointer(resolved.pointer, "items") },
            native, cache, active)}>`;
        active.delete(node);
        return type;
    }
    if (native.dialect === "swagger2" && node.type === "file") return "string";
    if (node.type) return String(node.type);
    return node.properties ? "object" : "unknown";
}

function appendShape(
    result: CompatibilityShape, schema: NativeParameterSchema, native: NativeOpenApiDocument,
    cache: ReferenceCache, basePath = "",
): void {
    type Frame = { readonly kind: "enter"; readonly schema: NativeParameterSchema; readonly path: string }
        | { readonly kind: "leave"; readonly node: object };
    const active = new WeakSet<object>();
    const pending: Frame[] = [{ kind: "enter", schema, path: basePath }];
    while (pending.length) {
        const frame = pending.pop()!;
        if (frame.kind === "leave") {
            active.delete(frame.node);
            continue;
        }
        const resolved = resolveObjectReference(frame.schema.node, native.document, cache, frame.schema.pointer);
        if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", frame.schema.pointer, "Expected a schema object");
        const node = resolved.value;
        if (frame.path) {
            result.types.set(frame.path, schemaType({ node, pointer: resolved.pointer }, native, cache));
            if (Array.isArray(node.enum)) result.enums.set(frame.path, new Set(node.enum.map(String)));
        }
        if (active.has(node)) continue;
        active.add(node);
        pending.push({ kind: "leave", node });
        const children: Extract<Frame, { kind: "enter" }>[] = [];
        for (const field of rootSchemaFields({ node, pointer: resolved.pointer }, native.document, cache)) {
            result.properties.add(field.name);
            if (!isRecord(field.node)) {
                throw new NativeAccessorError("INVALID_SCHEMA", field.pointer, "Expected a property schema object");
            }
            children.push({ kind: "enter", schema: { node: field.node, pointer: field.pointer },
                path: frame.path ? `${frame.path}.${field.name}` : field.name });
        }
        if (node.items !== undefined) {
            const pointer = appendPointer(resolved.pointer, "items");
            if (!isRecord(node.items)) throw new NativeAccessorError("INVALID_SCHEMA", pointer, "Expected an items schema");
            children.push({ kind: "enter", schema: { node: node.items, pointer }, path: `${frame.path}[]` });
        }
        for (const keyword of ["allOf", "oneOf", "anyOf"]) {
            if (node[keyword] === undefined) continue;
            const branches = node[keyword];
            const pointer = appendPointer(resolved.pointer, keyword);
            if (!Array.isArray(branches)) throw new NativeAccessorError("INVALID_SCHEMA", pointer, `Expected ${keyword} array`);
            branches.forEach((branch: unknown, index: number) => {
                const branchPointer = appendPointer(pointer, index);
                if (!isRecord(branch)) throw new NativeAccessorError("INVALID_SCHEMA", branchPointer, "Expected a schema object");
                children.push({ kind: "enter", schema: { node: branch, pointer: branchPointer }, path: frame.path });
            });
        }
        for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
}

export function compatibilityShape(
    payload: NativeRequestPayload | NativeResponsePayload | undefined,
    native: NativeOpenApiDocument, cache: ReferenceCache,
): CompatibilityShape | undefined {
    if (!payload || payload.kind === "none") return undefined;
    const shape: CompatibilityShape = { properties: new Set(), types: new Map(), enums: new Map() };
    if (payload.kind === "formData") {
        for (const field of payload.fields) {
            shape.properties.add(field.name);
            if (field.schema) appendShape(shape, field.schema, native, cache, field.name);
        }
        return shape;
    }
    const preferred = payload.kind === "response" ? ["application/json"]
        : ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"];
    if (payload.dialect === "openapi3" && !payload.media.some((media) => preferred.includes(media.mediaType))) {
        return undefined;
    }
    if (payload.dialect === "swagger2" && payload.mediaTypes.state === "declared" &&
        !payload.mediaTypes.values.some((media) => preferred.includes(media))) return undefined;
    const schema = selectPayloadSchema(payload, preferred, native.document, cache);
    if (!schema) return undefined;
    appendShape(shape, schema, native, cache);
    return shape;
}

export function comparisonParameters(
    native: NativeOpenApiDocument, operation: NativeOperation, cache: ReferenceCache,
): Map<string, { readonly required: boolean }> {
    const result = new Map(collectNativeParameters(native, operation, cache)
        .filter((parameter) => parameter.kind === "parameter")
        .map((parameter) => [`${parameter.location.toLowerCase()}:${parameter.name}`, { required: parameter.required }]));
    const payload = getNativeRequest(native, operation, cache);
    if (payload.kind === "none") return result;
    result.set("body:requestBody", {
        required: payload.kind === "formData" ? payload.fields.some((field) => field.required) : payload.required,
    });
    if (payload.kind === "formData") {
        for (const field of payload.fields) result.set(`formdata:${field.name}`, { required: field.required });
        return result;
    }
    const formMedia = payload.media.find((media) =>
        ["application/x-www-form-urlencoded", "multipart/form-data"].includes(media.mediaType));
    if (native.dialect === "openapi3" && formMedia?.schema) {
        const schema = selectPayloadSchema(payload, [formMedia.mediaType], native.document, cache);
        if (schema) {
            const names = new Set<string>();
            const required = new Set<string>();
            const pending = [schema];
            const visited = new WeakSet<object>();
            while (pending.length) {
                const candidate = pending.pop()!;
                const resolved = resolveObjectReference(candidate.node, native.document, cache, candidate.pointer);
                if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", candidate.pointer, "Expected a form schema");
                const node = resolved.value;
                if (visited.has(node)) continue;
                visited.add(node);
                for (const field of rootSchemaFields({ node, pointer: resolved.pointer }, native.document, cache)) {
                    names.add(field.name);
                }
                if (node.required !== undefined) {
                    if (!Array.isArray(node.required) || !node.required.every((name: unknown) => typeof name === "string")) {
                        throw new NativeAccessorError("INVALID_SCHEMA", appendPointer(resolved.pointer, "required"),
                            "Expected required field names");
                    }
                    node.required.forEach((name: string) => required.add(name));
                }
                if (node.allOf !== undefined) {
                    const pointer = appendPointer(resolved.pointer, "allOf");
                    if (!Array.isArray(node.allOf)) throw new NativeAccessorError("INVALID_SCHEMA", pointer, "Expected allOf array");
                    node.allOf.forEach((branch: unknown, index: number) => {
                        const branchPointer = appendPointer(pointer, index);
                        if (!isRecord(branch)) throw new NativeAccessorError("INVALID_SCHEMA", branchPointer, "Expected a form schema");
                        pending.push({ node: branch, pointer: branchPointer });
                    });
                }
            }
            for (const name of names) {
                result.set(`formdata:${name}`, { required: required.has(name) });
            }
        }
    }
    return result;
}
