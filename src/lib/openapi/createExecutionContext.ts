import type { SourceFormat } from "@/types/openapi";
import { NativeOpenApiError } from "./documentError";
import { classifyNativeOpenApiDocument } from "./parseNativeOpenApi";
import { sourceMap } from "./sourceMap";
import type { NativeClassification, NativeExecutionContext } from "./executionContext";

function sourceFormat(content: string): SourceFormat {
    if (!/^[\s]*[\[{]/.test(content)) return "yaml";
    try {
        // Detect syntax only; the engine's original parsed values remain authoritative.
        JSON.parse(content);
        return "json";
    } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        return "yaml";
    }
}

export function createExecutionContext(document: unknown, originalContent: string): NativeExecutionContext {
    const format = sourceFormat(originalContent);
    const sourceDocument = sourceMap(originalContent).sourceDocument;
    let classification: NativeClassification;
    try {
        classification = { ok: true, value: classifyNativeOpenApiDocument(document) };
    } catch (error: unknown) {
        if (!(error instanceof NativeOpenApiError)) throw error;
        classification = { ok: false, error };
    }
    return {
        document, originalContent, sourceFormat: format, sourceDocument, classification,
        native: classification.ok
            ? { ...classification.value, originalContent, sourceFormat: format, sourceDocument }
            : undefined,
    };
}
