import type { NativeOperation } from "@/types/openapi";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { isSwagger2Root } from "@/lib/openapi/media";
import { getParameterSchema } from "@/lib/openapi/parameters";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";
import { ruleParameterNodes } from "@/utils/nativeRule";

export interface NativeQueryParameter {
    readonly name: string;
    readonly index: number;
    readonly parameter: Record<string, unknown>;
    readonly pointer: string;
}

export function queryParameters(
    op: NativeOperation, spec: unknown, cache: ReferenceCache, retainSameLevelDuplicates = false,
): NativeQueryParameter[] {
    const nodes = ruleParameterNodes(op, spec, cache);
    if (!retainSameLevelDuplicates) {
        return nodes.map(({ parameter, resolvedPointer }, index) => ({
            name: String(parameter.name).toLowerCase(), parameter, pointer: resolvedPointer, index,
        })).filter(({ parameter }) => String(parameter.in).toLowerCase() === "query");
    }
    // Keep repeated declarations in the winning level without reviving overridden path parameters.
    const identity = (parameter: Record<string, unknown>) => JSON.stringify([parameter.in, parameter.name]);
    const levels = new Map(nodes.map((node) => [identity(node.parameter), node.level]));
    const result: NativeQueryParameter[] = [];
    for (const [level, parent, pointer] of [
        ["path", op.pathItem, op.resolvedPathItemPointer],
        ["operation", op.operation, op.pointer],
    ] as const) {
        if (!Array.isArray(parent.parameters)) continue;
        parent.parameters.forEach((raw: unknown, index: number) => {
            const source = appendPointer(pointer, "parameters", index);
            const resolved = resolveObjectReference(raw, spec, cache, source);
            if (!resolved) throw new NativeAccessorError("INVALID_DECLARATION", source, "Expected a parameter object");
            const parameter = resolved.value;
            if (levels.get(identity(parameter)) !== level || String(parameter.in).toLowerCase() !== "query") return;
            result.push({
                name: String(parameter.name).toLowerCase(), parameter, pointer: resolved.pointer, index: result.length,
            });
        });
    }
    return result;
}

export function queryParameterSchema(parameter: NativeQueryParameter, spec: unknown, cache: ReferenceCache) {
    const node = parameter.parameter;
    if (!isSwagger2Root(spec)) {
        if (node.schema !== undefined && !isRecord(node.schema)) {
            throw new NativeAccessorError("INVALID_SCHEMA", appendPointer(parameter.pointer, "schema"), "Expected a parameter schema");
        }
        if (node.schema === undefined && node.content !== undefined) {
            const pointer = appendPointer(parameter.pointer, "content");
            if (!isRecord(node.content)) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a content map");
            const content = node.content;
            const key = ["application/json", "application/xml", ...Object.keys(content)]
                .find((type) => Object.hasOwn(content, type));
            if (key === undefined) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a parameter media type");
            const media = content[key];
            const mediaPointer = appendPointer(pointer, key);
            if (!isRecord(media)) throw new NativeAccessorError("INVALID_DECLARATION", mediaPointer, "Expected a media type object");
            if (media.schema !== undefined && !isRecord(media.schema)) {
                throw new NativeAccessorError("INVALID_SCHEMA", appendPointer(mediaPointer, "schema"), "Expected a parameter schema");
            }
        }
    }
    return getParameterSchema(node, spec, cache, parameter.pointer);
}
