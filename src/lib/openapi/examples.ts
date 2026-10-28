import type { NativeExample, RuleConfig } from "@/types/example";
import type { NativeParameterSchema } from "@/types/openapi";
import { NativeExampleError } from "./exampleError";
import { hasOwnField } from "./media";
import { getRequestPayload, getResponsePayload } from "./payloads";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "./references";

interface ExampleContext {
    readonly direction: "request" | "response";
    readonly mediaType: string | undefined;
    readonly statusCode: string | undefined;
    readonly schema: NativeParameterSchema | undefined;
}

function example(
    value: unknown, pointer: string, context: ExampleContext, scope: NativeExample["scope"] = "payload",
    declarationPointer = pointer, resolvedPointer = pointer,
): NativeExample {
    return { value, source: pointer, pointer, declarationPointer, resolvedPointer, scope, ...context };
}

function sources(config: RuleConfig, direction: "request" | "response"): Set<string> {
    const supported = new Set([
        "content.example", "content.examples", "schema.example", ...(direction === "response" ? ["response.examples"] : []),
    ]);
    const selected = config.exampleSources?.[direction] ?? [...supported];
    if (!Array.isArray(selected) || selected.some((source) => typeof source !== "string" || !supported.has(source))) {
        throw new NativeExampleError("#", `Unsupported exampleSources.${direction} configuration`);
    }
    return new Set(selected);
}

function mediaExamples(
    node: unknown, pointer: string, allowed: ReadonlySet<string>, context: ExampleContext,
    document: unknown, cache: ReferenceCache,
): NativeExample[] {
    if (!isRecord(node)) throw new NativeExampleError(pointer, "Expected a media object");
    const found: NativeExample[] = [];
    if (allowed.has("content.example") && hasOwnField(node, "example")) {
        found.push(example(node.example, appendPointer(pointer, "example"), context));
    }
    if (allowed.has("content.examples") && hasOwnField(node, "examples")) {
        if (!isRecord(node.examples)) throw new NativeExampleError(appendPointer(pointer, "examples"), "Expected an examples map");
        for (const [name, raw] of Object.entries(node.examples)) {
            const declaration = appendPointer(pointer, "examples", name);
            const resolved = resolveObjectReference(raw, document, cache, declaration);
            if (!resolved) throw new NativeExampleError(declaration, "Expected an Example Object");
            const value = resolved.value;
            if (hasOwnField(value, "externalValue")) {
                throw new NativeExampleError(resolved.pointer, "External example payloads are unsupported; no network request was made");
            }
            if (!hasOwnField(value, "value")) {
                throw new NativeExampleError(resolved.pointer, "Example Object has no inline value");
            }
            found.push(example(value.value, appendPointer(resolved.pointer, "value"), context, "payload", declaration, resolved.pointer));
        }
    }
    return found;
}

function schemaExamples(
    declaration: NativeParameterSchema | undefined, includeRoot: boolean, context: ExampleContext,
    document: unknown, cache: ReferenceCache,
): NativeExample[] {
    const found: NativeExample[] = [];
    const active = new Set<object>();
    const visit = (raw: unknown, pointer: string, root: boolean) => {
        const resolved = resolveObjectReference(raw, document, cache, pointer);
        if (!resolved) throw new NativeExampleError(pointer, "Expected a schema object");
        const node = resolved.value;
        if (active.has(node)) return;
        active.add(node);
        const schema = { node, pointer: resolved.pointer };
        if ((!root || includeRoot) && hasOwnField(node, "example")) {
            found.push(example(node.example, appendPointer(resolved.pointer, "example"), { ...context, schema }, root ? "payload" : "property"));
        }
        if (hasOwnField(node, "properties")) {
            if (!isRecord(node.properties)) throw new NativeExampleError(resolved.pointer, "Expected schema properties");
            for (const [key, child] of Object.entries(node.properties)) visit(child, appendPointer(resolved.pointer, "properties", key), false);
        }
        if (hasOwnField(node, "items")) visit(node.items, appendPointer(resolved.pointer, "items"), false);
        if (isRecord(node.additionalProperties)) visit(node.additionalProperties, appendPointer(resolved.pointer, "additionalProperties"), false);
        for (const keyword of ["allOf", "oneOf", "anyOf"]) {
            if (!hasOwnField(node, keyword)) continue;
            const branches = node[keyword];
            if (!Array.isArray(branches)) throw new NativeExampleError(resolved.pointer, `Expected ${keyword} array`);
            branches.forEach((branch: unknown, index: number) => visit(branch, appendPointer(resolved.pointer, keyword, index), false));
        }
        active.delete(node);
    };
    if (declaration) visit(declaration.node, declaration.pointer, true);
    return found;
}

function unique(examples: NativeExample[]): NativeExample[] {
    const seen = new Set<string>();
    return examples.filter((entry) => {
        const key = JSON.stringify([entry.scope, entry.pointer, entry.mediaType, entry.statusCode]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function collectRequestExamples(
    operation: unknown, pathItem: unknown, document: unknown, config: RuleConfig, cache: ReferenceCache = new Map(),
    pointers?: { readonly pathItem: string; readonly operation: string },
): NativeExample[] {
    const allowed = sources(config, "request");
    const payload = getRequestPayload(operation, pathItem, document, cache, pointers);
    if (payload.kind !== "body") return [];
    const found: NativeExample[] = [];
    if (payload.dialect === "swagger2") {
        if (!allowed.has("schema.example")) return [];
        const mediaType = payload.mediaTypes.values.length === 1 ? payload.mediaTypes.values[0] : undefined;
        return unique(schemaExamples(payload.schema, true, {
            direction: "request", mediaType, statusCode: undefined, schema: payload.schema,
        }, document, cache));
    }
    for (const media of payload.media) {
        const context: ExampleContext = { direction: "request", mediaType: media.mediaType, statusCode: undefined, schema: media.schema };
        const explicit = mediaExamples(media.node, media.pointer, allowed, context, document, cache);
        found.push(...explicit);
        if (allowed.has("schema.example")) {
            found.push(...schemaExamples(media.schema, explicit.length === 0, context, document, cache));
        }
    }
    return unique(found);
}

export function collectResponseExamples(
    operation: unknown, statusCodes: readonly string[], document: unknown, config: RuleConfig,
    cache: ReferenceCache = new Map(), operationPointer = "#",
): NativeExample[] {
    const allowed = sources(config, "response");
    const found: NativeExample[] = [];
    for (const statusCode of statusCodes) {
        const payload = getResponsePayload(operation, statusCode, document, cache, operationPointer);
        if (!payload) continue;
        if (payload.dialect === "swagger2") {
            const explicit: NativeExample[] = [];
            if (allowed.has("response.examples") && hasOwnField(payload.response.node, "examples")) {
                const values = payload.response.node.examples;
                if (!isRecord(values)) throw new NativeExampleError(payload.response.resolvedPointer, "Expected response examples map");
                for (const [mediaType, value] of Object.entries(values)) {
                    explicit.push(example(value, appendPointer(payload.response.resolvedPointer, "examples", mediaType), {
                        direction: "response", mediaType, statusCode, schema: payload.schema,
                    }));
                }
            }
            found.push(...explicit);
            if (allowed.has("schema.example")) {
                const mediaType = payload.mediaTypes.values.length === 1 ? payload.mediaTypes.values[0] : undefined;
                found.push(...schemaExamples(payload.schema, explicit.length === 0, {
                    direction: "response", mediaType, statusCode, schema: payload.schema,
                }, document, cache));
            }
        } else {
            for (const media of payload.media) {
                const context: ExampleContext = { direction: "response", mediaType: media.mediaType, statusCode, schema: media.schema };
                const explicit = mediaExamples(media.node, media.pointer, allowed, context, document, cache);
                found.push(...explicit);
                if (allowed.has("schema.example")) found.push(...schemaExamples(media.schema, explicit.length === 0, context, document, cache));
            }
        }
    }
    return unique(found);
}
