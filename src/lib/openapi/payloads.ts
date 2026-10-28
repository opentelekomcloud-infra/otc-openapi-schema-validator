import type {
    ContentTypeMatch, NativeMedia, NativeOpenApiDocument, NativeOperation, NativeParameterSchema,
    NativeRequestPayload, NativeResponsePayload, NativeSourceNode, NativeStringList,
} from "@/types/openapi";
import { NativeAccessorError } from "./accessorError";
import { getEffectiveStringList, hasOwnField, isSwagger2Root } from "./media";
import { collectParameterDescriptors } from "./parameters";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "./references";

function schemaDeclaration(raw: unknown, pointer: string): NativeParameterSchema | undefined {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) throw new NativeAccessorError("INVALID_SCHEMA", pointer, "Expected a schema object");
    return { node: raw, pointer };
}

function contentTypes(node: Readonly<Record<string, unknown>>, pointer: string): NativeStringList {
    if (!hasOwnField(node, "content")) return { state: "unspecified", values: [] };
    const contentPointer = appendPointer(pointer, "content");
    if (!isRecord(node.content)) {
        throw new NativeAccessorError("INVALID_DECLARATION", contentPointer, "Expected a content map");
    }
    return {
        state: "declared", values: Object.keys(node.content), node: node.content, pointer: contentPointer, level: "content",
    };
}

function contentMedia(
    node: Readonly<Record<string, unknown>>, pointer: string,
): { mediaTypes: NativeStringList; media: NativeMedia[] } {
    const mediaTypes = contentTypes(node, pointer);
    if (!hasOwnField(node, "content")) {
        return { mediaTypes: { state: "unspecified", values: [] }, media: [] };
    }
    const content = node.content;
    const contentPointer = appendPointer(pointer, "content");
    if (!isRecord(content)) {
        throw new NativeAccessorError("INVALID_DECLARATION", contentPointer, "Expected a content map");
    }
    const media = Object.entries(content).map(([mediaType, value]) => {
        const mediaPointer = appendPointer(contentPointer, mediaType);
        if (!isRecord(value)) {
            throw new NativeAccessorError("INVALID_DECLARATION", mediaPointer, "Expected a media type object");
        }
        return {
            mediaType, node: value, pointer: mediaPointer,
            schema: schemaDeclaration(value.schema, appendPointer(mediaPointer, "schema")),
        };
    });
    return {
        mediaTypes, media,
    };
}

function swaggerMedia(types: NativeStringList, schema?: NativeParameterSchema): NativeMedia[] {
    if (types.state === "unspecified") return [];
    return types.values.map((mediaType, index) => ({
        mediaType, node: mediaType, pointer: appendPointer(types.pointer, index), schema,
    }));
}

export function getRequestPayload(
    operation: unknown, pathItem: unknown, document: unknown, cache: ReferenceCache = new Map(),
    pointers?: { readonly pathItem: string; readonly operation: string },
): NativeRequestPayload {
    const operationPointer = pointers?.operation ?? "#";
    if (isSwagger2Root(document)) {
        const mediaTypes = getEffectiveStringList(document, operation, "consumes", operationPointer);
        const params = collectParameterDescriptors(pathItem, operation, document, cache, pointers);
        const bodies = params.filter((param) => param.kind === "body");
        const fields = params.filter((param) => param.kind === "formData");
        if (bodies.length > 1 || (bodies.length && fields.length)) {
            throw new NativeAccessorError(
                "CONFLICTING_PAYLOAD", operationPointer, "Multiple body parameters or mixed body/formData",
            );
        }
        const common = { dialect: "swagger2" as const, mediaTypes };
        if (fields.length) {
            return { ...common, kind: "formData", hasBody: true, fields, media: swaggerMedia(mediaTypes) };
        }
        const parameter = bodies[0];
        if (!parameter) return { ...common, kind: "none", hasBody: false, media: [] };
        if (hasOwnField(parameter.parameter, "schema") && !isRecord(parameter.parameter.schema)) {
            throw new NativeAccessorError(
                "INVALID_SCHEMA", appendPointer(parameter.resolvedPointer, "schema"), "Expected a body schema object",
            );
        }
        return {
            ...common, kind: "body", hasBody: true,
            body: {
                raw: parameter.raw, node: parameter.parameter,
                pointer: parameter.pointer, resolvedPointer: parameter.resolvedPointer,
            },
            required: parameter.required, schema: parameter.schema, media: swaggerMedia(mediaTypes, parameter.schema),
        };
    }

    if (!hasOwnField(operation, "requestBody")) {
        return {
            dialect: "openapi3", kind: "none", hasBody: false,
            mediaTypes: { state: "unspecified", values: [] }, media: [],
        };
    }
    const pointer = appendPointer(operationPointer, "requestBody");
    const resolved = resolveObjectReference(operation.requestBody, document, cache, pointer);
    if (!resolved) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a requestBody object");
    return {
        dialect: "openapi3", kind: "body", hasBody: true,
        body: { raw: operation.requestBody, node: resolved.value, pointer, resolvedPointer: resolved.pointer },
        required: resolved.value.required === true, schema: undefined,
        ...contentMedia(resolved.value, resolved.pointer),
    };
}

function responseSource(
    operation: unknown, statusCode: string, document: unknown, cache: ReferenceCache, operationPointer: string,
): NativeSourceNode | undefined {
    if (!isRecord(operation) || !isRecord(operation.responses) || !hasOwnField(operation.responses, statusCode)) {
        return undefined;
    }
    const raw = operation.responses[statusCode];
    const pointer = appendPointer(operationPointer, "responses", statusCode);
    const resolved = resolveObjectReference(raw, document, cache, pointer);
    if (!resolved) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a response object");
    return { raw, node: resolved.value, pointer, resolvedPointer: resolved.pointer };
}

export function getResponsePayload(
    operation: unknown, statusCode: string, document: unknown, cache: ReferenceCache = new Map(), operationPointer = "#",
): NativeResponsePayload | undefined {
    const response = responseSource(operation, statusCode, document, cache, operationPointer);
    if (!response) return undefined;
    const node = response.node;
    if (isSwagger2Root(document)) {
        const mediaTypes = getEffectiveStringList(document, operation, "produces", operationPointer);
        const schema = schemaDeclaration(
            node.schema, appendPointer(response.resolvedPointer, "schema"),
        );
        return {
            kind: "response", dialect: "swagger2", statusCode, response, schema,
            hasBody: schema !== undefined, mediaTypes, media: swaggerMedia(mediaTypes, schema),
        };
    }
    if (hasOwnField(node, "schema")) {
        throw new NativeAccessorError(
            "INVALID_DECLARATION", appendPointer(response.resolvedPointer, "schema"),
            "OpenAPI 3 responses use content, not direct response.schema",
        );
    }
    const content = contentMedia(node, response.resolvedPointer);
    return {
        kind: "response", dialect: "openapi3", statusCode, response, schema: undefined,
        hasBody: content.media.length > 0, ...content,
    };
}

export function selectPayloadSchema(
    payload: NativeRequestPayload | NativeResponsePayload | undefined, preferred: readonly string[],
    document: unknown, cache: ReferenceCache = new Map(), selection: "firstMedia" | "firstSchema" = "firstMedia",
): NativeParameterSchema | undefined {
    if (!payload || payload.kind === "none" || payload.kind === "formData") return undefined;
    const resolveSchema = (schema: NativeParameterSchema | undefined): NativeParameterSchema | undefined => {
        if (!schema) return undefined;
        const target = resolveObjectReference(schema.node, document, cache, schema.pointer);
        if (!target) throw new NativeAccessorError("INVALID_SCHEMA", schema.pointer, "Expected a schema object");
        return { node: target.value, pointer: target.pointer };
    };
    if (payload.dialect === "swagger2") return resolveSchema(payload.schema);
    if (selection === "firstSchema") {
        for (const mediaType of preferred) {
            const schema = payload.media.find((entry) => entry.mediaType === mediaType)?.schema;
            if (schema) return resolveSchema(schema);
        }
        return resolveSchema(payload.media[0]?.schema);
    }
    const media = preferred.map((type) => payload.media.find((entry) => entry.mediaType === type)).find(Boolean)
        ?? payload.media[0];
    return resolveSchema(media?.schema);
}

export function matchResponseContentTypes(
    payload: Pick<NativeResponsePayload, "hasBody" | "mediaTypes"> | undefined, contentTypes: readonly string[],
): ContentTypeMatch {
    if (!payload?.hasBody) return "mismatch";
    if (payload.mediaTypes.state === "unspecified") return "unknown";
    return payload.mediaTypes.values.some((mediaType) => contentTypes.includes(mediaType)) ? "match" : "mismatch";
}

export function getResponseMediaMatch(
    operation: unknown, statusCode: string, document: unknown, contentTypesToCheck: readonly string[],
    cache: ReferenceCache = new Map(), operationPointer = "#",
): ContentTypeMatch {
    const response = responseSource(operation, statusCode, document, cache, operationPointer);
    if (!response) return "mismatch";
    const types = isSwagger2Root(document)
        ? getEffectiveStringList(document, operation, "produces", operationPointer)
        : contentTypes(response.node, response.resolvedPointer);
    const hasBody = isSwagger2Root(document) ? response.node.schema !== undefined : types.values.length > 0;
    return matchResponseContentTypes({ hasBody, mediaTypes: types }, contentTypesToCheck);
}

export function getNativeRequest(
    native: NativeOpenApiDocument, operation: NativeOperation, cache?: ReferenceCache,
): NativeRequestPayload {
    return getRequestPayload(operation.operation, operation.pathItem, native.document, cache, {
        pathItem: operation.resolvedPathItemPointer, operation: operation.pointer,
    });
}

export function getNativeResponse(
    native: NativeOpenApiDocument, operation: NativeOperation, statusCode: string, cache?: ReferenceCache,
): NativeResponsePayload | undefined {
    return getResponsePayload(operation.operation, statusCode, native.document, cache, operation.pointer);
}
