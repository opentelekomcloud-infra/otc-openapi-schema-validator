import type { Document } from "yaml";
import type { NativeOpenApiContext, NativeOpenApiDocument, SourceFormat } from "@/types/openapi";
import type { NativeOpenApiError } from "./documentError";

export type NativeClassification =
    | { readonly ok: true; readonly value: NativeOpenApiDocument }
    | { readonly ok: false; readonly error: NativeOpenApiError };

export interface NativeExecutionContext {
    readonly document: unknown;
    readonly originalContent: string;
    readonly sourceFormat: SourceFormat;
    readonly sourceDocument: Document.Parsed;
    readonly classification: NativeClassification;
    readonly native: NativeOpenApiContext | undefined;
}

const active = new WeakMap<object, NativeExecutionContext>();

export function executionContextFor(document: unknown): NativeExecutionContext | undefined {
    return document !== null && typeof document === "object" ? active.get(document) : undefined;
}

export function bindExecutionContext(context: NativeExecutionContext): () => void {
    const document = context.document;
    if (document === null || typeof document !== "object") return () => undefined;
    const previous = active.get(document);
    active.set(document, context);
    return () => {
        if (previous) active.set(document, previous);
        else active.delete(document);
    };
}
