import type { Document } from "yaml";

export type OpenApi30Version = `3.0.${number}`;
export type SourceFormat = "yaml" | "json";

// These are version-qualified roots, not a replacement for structural rule validation.
export interface Swagger2Document {
    readonly swagger: "2.0" | 2;
    readonly openapi?: never;
    readonly [key: string]: unknown;
}

export interface OpenApi30Document {
    readonly openapi: OpenApi30Version;
    readonly swagger?: never;
    readonly [key: string]: unknown;
}

export type NativeOpenApiDocument =
    | { readonly dialect: "swagger2"; readonly formatVersion: "2.0"; readonly document: Swagger2Document }
    | { readonly dialect: "openapi3"; readonly formatVersion: OpenApi30Version; readonly document: OpenApi30Document };

export interface SourceRange {
    readonly from: number;
    readonly to: number;
}

export type NativeOpenApiContext = NativeOpenApiDocument & {
    readonly originalContent: string;
    readonly sourceFormat: SourceFormat;
    readonly sourceDocument: Document.Parsed;
};
