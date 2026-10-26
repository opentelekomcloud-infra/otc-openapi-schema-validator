import type { NativeOperation, NativeParameterSchema, NativeRequestPayload, NativeResponsePayload } from "@/types/openapi";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { selectPayloadSchema } from "@/lib/openapi/payloads";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";
import { ruleParameterNodes } from "@/utils/nativeRule";

export interface NamedSchemaField {
    readonly name: string;
    readonly owner: Record<string, unknown>;
    readonly node: unknown;
    readonly pointer: string;
}

export function namingSchemas(
    payload: NativeRequestPayload | NativeResponsePayload | undefined, spec: unknown, cache: ReferenceCache, allMedia = false,
): NativeParameterSchema[] {
    if (!payload || payload.kind === "none" || payload.kind === "formData") return [];
    if (!allMedia || payload.dialect === "swagger2") {
        const schema = selectPayloadSchema(payload, ["application/json"], spec, cache, "firstSchema");
        return schema ? [schema] : [];
    }
    return payload.media.flatMap((media) => {
        if (!media.schema) return [];
        const resolved = resolveObjectReference(media.schema.node, spec, cache, media.schema.pointer);
        if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", media.schema.pointer, "Expected a schema object");
        return [{ node: resolved.value, pointer: resolved.pointer }];
    });
}

export function rootSchemaFields(schema: NativeParameterSchema, spec: unknown, cache: ReferenceCache): NamedSchemaField[] {
    const resolved = resolveObjectReference(schema.node, spec, cache, schema.pointer);
    if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", schema.pointer, "Expected a schema object");
    if (resolved.value.properties === undefined) return [];
    const pointer = appendPointer(resolved.pointer, "properties");
    if (!isRecord(resolved.value.properties)) {
        throw new NativeAccessorError("INVALID_SCHEMA", pointer, "Expected schema properties");
    }
    const owner = resolved.value.properties;
    return Object.entries(owner).map(([name, node]) => ({ name, node, owner, pointer: appendPointer(pointer, name) }));
}

export function schemaNameFields(
    schema: NativeParameterSchema, spec: unknown, cache: ReferenceCache,
    options: {
        readonly maps?: boolean; readonly compositionsFirst?: boolean; readonly visited?: WeakSet<object>;
        readonly visitSchema?: (schema: NativeParameterSchema) => void;
    } = {},
): NamedSchemaField[] {
    type Frame = { kind: "schema"; node: unknown; pointer: string } | { kind: "field"; field: NamedSchemaField };
    const pending: Frame[] = [{ kind: "schema", ...schema }];
    const visited = options.visited ?? new WeakSet<object>();
    const fields: NamedSchemaField[] = [];
    while (pending.length) {
        const frame = pending.pop()!;
        if (frame.kind === "field") {
            fields.push(frame.field);
            pending.push({ kind: "schema", node: frame.field.node, pointer: frame.field.pointer });
            continue;
        }
        const resolved = resolveObjectReference(frame.node, spec, cache, frame.pointer);
        if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", frame.pointer, "Expected a schema object");
        const node = resolved.value;
        if (visited.has(node)) continue;
        visited.add(node);
        options.visitSchema?.({ node, pointer: resolved.pointer });
        const children: Frame[] = rootSchemaFields({ node, pointer: resolved.pointer }, spec, cache)
            .map((field) => ({ kind: "field", field }));
        if (node.items !== undefined) {
            children.push({ kind: "schema", node: node.items, pointer: appendPointer(resolved.pointer, "items") });
        }
        if (options.maps && isRecord(node.additionalProperties)) {
            children.push({ kind: "schema",
                node: node.additionalProperties, pointer: appendPointer(resolved.pointer, "additionalProperties"),
            });
        }
        const compositions: Frame[] = [];
        for (const keyword of ["allOf", "oneOf", "anyOf"]) {
            const branches = node[keyword];
            if (branches === undefined) continue;
            if (!Array.isArray(branches)) {
                throw new NativeAccessorError("INVALID_SCHEMA", appendPointer(resolved.pointer, keyword), `Expected ${keyword} array`);
            }
            branches.forEach((branch: unknown, index: number) => compositions.push({
                kind: "schema", node: branch, pointer: appendPointer(resolved.pointer, keyword, index),
            }));
        }
        const ordered = options.compositionsFirst ? [...compositions, ...children] : [...children, ...compositions];
        for (let index = ordered.length - 1; index >= 0; index--) pending.push(ordered[index]);
    }
    return fields;
}

export function declaredParameterGroups(op: NativeOperation, spec: unknown, cache: ReferenceCache) {
    ruleParameterNodes(op, spec, cache);
    return ([op.pathItem, op.operation] as const).map((parent, level) => {
        const pointer = level === 0 ? op.resolvedPathItemPointer : op.pointer;
        if (!Array.isArray(parent.parameters)) return [];
        return parent.parameters.map((raw: unknown, index: number) => {
            const source = appendPointer(pointer, "parameters", index);
            const resolved = resolveObjectReference(raw, spec, cache, source);
            if (!resolved) throw new NativeAccessorError("INVALID_DECLARATION", source, "Expected a parameter object");
            return resolved.value;
        });
    });
}
