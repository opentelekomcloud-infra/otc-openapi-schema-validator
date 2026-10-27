import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Document } from "yaml";
import type {
    NativeOpenApiContext, NativeOpenApiDocument, OpenApi30Document, OpenApi30Version,
    SourceFormat, SourceRange, Swagger2Document,
} from "@/types/openapi";
import { NativeOpenApiError } from "./documentError";
import { executionContextFor } from "./executionContext";

export interface NativeParseOptions {
    readonly format?: SourceFormat | "auto";
}

export function isDocumentObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function isOpenApi30Version(value: unknown): value is OpenApi30Version {
    return typeof value === "string" && value.match(/^3\.0\.\d+$/)?.[0] === value;
}

export function isSwagger2Document(value: unknown): value is Swagger2Document {
    return isDocumentObject(value) && Object.hasOwn(value, "swagger") && !Object.hasOwn(value, "openapi") &&
        (value.swagger === "2.0" || value.swagger === 2);
}

export function isOpenApi30Document(value: unknown): value is OpenApi30Document {
    return isDocumentObject(value) && Object.hasOwn(value, "openapi") && !Object.hasOwn(value, "swagger") &&
        isOpenApi30Version(value.openapi);
}

export function classifyNativeOpenApiDocument(value: unknown): NativeOpenApiDocument {
    const classification = executionContextFor(value)?.classification;
    if (classification) {
        if (classification.ok) return classification.value;
        throw classification.error;
    }
    if (!isDocumentObject(value)) {
        throw new NativeOpenApiError("INVALID_DOCUMENT", "The specification root must be an object.");
    }
    const hasSwagger = Object.hasOwn(value, "swagger");
    const hasOpenapi = Object.hasOwn(value, "openapi");
    if (hasSwagger && hasOpenapi) {
        throw new NativeOpenApiError("CONFLICTING_VERSIONS", "Define either 'swagger' or 'openapi', not both.");
    }
    if (!hasSwagger && !hasOpenapi) {
        throw new NativeOpenApiError("MISSING_VERSION", "Missing 'swagger' or 'openapi' format version.");
    }
    if (isSwagger2Document(value)) return { dialect: "swagger2", formatVersion: "2.0", document: value };
    if (isOpenApi30Document(value)) return { dialect: "openapi3", formatVersion: value.openapi, document: value };
    const versionKey = hasSwagger ? "swagger" : "openapi";
    throw new NativeOpenApiError("UNSUPPORTED_VERSION",
        `Unsupported '${versionKey}' version. Expected Swagger "2.0" (or numeric 2) or OpenAPI 3.0.x.`,
        { versionKey });
}

function sourceRange(content: string, position?: readonly number[] | null): SourceRange {
    const from = Math.max(0, Math.min(content.length, position?.[0] ?? 0));
    return { from, to: Math.max(from, Math.min(content.length, position?.[1] ?? content.length)) };
}

function validateGraph(
    value: unknown,
    childrenOf: (node: unknown) => readonly unknown[],
    onCycle: (node: object) => NativeOpenApiError
): void {
    const active = new WeakSet<object>();
    const visited = new WeakSet<object>();
    type Frame = { kind: "enter"; value: unknown } | { kind: "leave"; value: object };
    const pending: Frame[] = [{ kind: "enter", value }];
    while (pending.length) {
        const frame = pending.pop();
        if (!frame) break;
        if (frame.kind === "leave") {
            active.delete(frame.value);
            visited.add(frame.value);
            continue;
        }
        const node = frame.value;
        if (node !== null && typeof node === "object") {
            if (active.has(node)) throw onCycle(node);
            if (visited.has(node)) continue;
            active.add(node);
            pending.push({ kind: "leave", value: node });
        }
        const children = childrenOf(node);
        for (let index = children.length - 1; index >= 0; index--) {
            pending.push({ kind: "enter", value: children[index] });
        }
    }
}

function cyclicAliasError(content: string, node?: object): NativeOpenApiError {
    return new NativeOpenApiError("NON_JSON_VALUE",
        "Cyclic YAML aliases are not supported. Use schema $ref values for recursive schemas.",
        { range: sourceRange(content, isNode(node) ? node.range : undefined) });
}

function validateSourceNodes(source: Document.Parsed, content: string): void {
    const resolve = (node: unknown) => isAlias(node) ? node.resolve(source) : node;
    validateGraph(source.contents, (node) => {
        if (isAlias(node)) {
            const target = node.resolve(source);
            if (!target) {
                throw new NativeOpenApiError("INVALID_SYNTAX", `Unresolved YAML alias "${node.source}".`,
                    { range: sourceRange(content, node.range) });
            }
            return [target];
        }
        if (isSeq(node)) return node.items;
        if (!isMap(node)) return [];
        const names = new Set<string>();
        const children: unknown[] = [];
        for (const pair of node.items) {
            const key = resolve(pair.key);
            const range = sourceRange(content, isNode(pair.key) ? pair.key.range : undefined);
            if (isScalar(key) && typeof key.value === "symbol" && key.source === "<<") {
                const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
                if (!sources.every((candidate) => isMap(resolve(candidate)))) {
                    throw new NativeOpenApiError("INVALID_SYNTAX", "YAML merge sources must be mappings or mapping aliases.",
                        { range });
                }
            } else {
                if (!isScalar(key) || !["string", "number"].includes(typeof key.value)) {
                    throw new NativeOpenApiError("NON_JSON_VALUE", "Specification mapping keys must be strings or numbers.",
                        { range });
                }
                const name = String(key.value);
                if (names.has(name)) {
                    throw new NativeOpenApiError("INVALID_SYNTAX", `Duplicate mapping key "${name}".`, { range });
                }
                names.add(name);
            }
            children.push(pair.key, pair.value);
        }
        return children;
    }, (node) => cyclicAliasError(content, node));
}

function validateJsonValues(value: unknown, content: string): void {
    validateGraph(value, (node) => {
        if (node === null || typeof node === "string" || typeof node === "boolean") return [];
        if (typeof node === "number" && Number.isFinite(node)) return [];
        if (Array.isArray(node) || isDocumentObject(node)) return Object.values(node);
        throw new NativeOpenApiError("NON_JSON_VALUE",
            "Specification values must be JSON-compatible; non-finite numbers and custom objects are not supported.",
            { range: sourceRange(content) });
    }, () => cyclicAliasError(content));
}

function parseSource(content: string, format: SourceFormat): { source: Document.Parsed; value: unknown } {
    let jsonValue: unknown;
    if (format === "json") {
        try {
            jsonValue = JSON.parse(content);
        } catch (error: unknown) {
            if (!(error instanceof SyntaxError)) throw error;
            throw new NativeOpenApiError("INVALID_SYNTAX", `Invalid JSON: ${error.message}`,
                { range: sourceRange(content), cause: error });
        }
    }
    const source = parseDocument(content, {
        version: "1.2",
        ...(format === "json" ? { schema: "json" } : {}),
        strict: true,
        uniqueKeys: true,
        merge: format === "yaml",
        keepSourceTokens: true,
        prettyErrors: false,
    });
    const issue = source.errors[0] ?? source.warnings[0];
    if (issue) {
        throw new NativeOpenApiError("INVALID_SYNTAX", `Invalid ${format.toUpperCase()}: ${issue.message}`,
            { range: sourceRange(content, issue.pos), cause: issue });
    }
    validateSourceNodes(source, content);
    if (format === "json") return { source, value: jsonValue };
    try {
        const value: unknown = source.toJS({ maxAliasCount: 100 });
        return { source, value };
    } catch (error: unknown) {
        if (!(error instanceof ReferenceError)) throw error;
        throw new NativeOpenApiError("INVALID_SYNTAX", `Invalid YAML aliases: ${error.message}`,
            { range: sourceRange(content), cause: error });
    }
}

/**
 * Parse one native document without conversion or reserialization.
 * Auto treats a leading "{" or "[" as strict JSON; flow-style YAML requires format: "yaml".
 */
export function parseNativeOpenApi(content: unknown, options: NativeParseOptions = {}): NativeOpenApiContext {
    if (typeof content !== "string") {
        throw new NativeOpenApiError("INVALID_INPUT", "Specification content must be a string.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        (options.format !== undefined && !["auto", "yaml", "json"].includes(options.format))) {
        throw new NativeOpenApiError("INVALID_INPUT", "Parser format must be 'auto', 'yaml', or 'json'.",
            { range: sourceRange(content) });
    }
    const firstCharacter = content.trimStart()[0];
    const sourceFormat = !options.format || options.format === "auto"
        ? (firstCharacter === "{" || firstCharacter === "[" ? "json" : "yaml") : options.format;
    const { source, value } = parseSource(content, sourceFormat);
    validateJsonValues(value, content);
    let classified: NativeOpenApiDocument;
    try {
        classified = classifyNativeOpenApiDocument(value);
    } catch (error: unknown) {
        if (!(error instanceof NativeOpenApiError)) throw error;
        const node = error.versionKey ? source.get(error.versionKey, true) : source.contents;
        throw new NativeOpenApiError(error.code, error.message, {
            range: sourceRange(content, isNode(node) ? node.range : undefined),
            versionKey: error.versionKey,
            cause: error,
        });
    }
    return { ...classified, originalContent: content, sourceFormat, sourceDocument: source };
}
