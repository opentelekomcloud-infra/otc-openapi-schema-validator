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

export interface NativeOperation {
    readonly path: string;
    readonly method: string;
    readonly rawPathItem: unknown;
    readonly pathItem: Readonly<Record<string, unknown>>;
    readonly operation: Readonly<Record<string, unknown>>;
    readonly pathItemPointer: string;
    readonly resolvedPathItemPointer: string;
    readonly pointer: string;
}

export interface NativeParameterSchema {
    readonly node: Readonly<Record<string, unknown>>;
    readonly pointer: string;
}

export interface NativeParameter {
    readonly raw: unknown;
    readonly parameter: Readonly<Record<string, unknown>>;
    readonly name: string;
    readonly location: string;
    readonly required: boolean;
    readonly kind: "parameter" | "body" | "formData";
    readonly level: "path" | "operation";
    readonly index: number;
    readonly pointer: string;
    readonly resolvedPointer: string;
    readonly schema: NativeParameterSchema | undefined;
    readonly style: unknown;
    readonly explode: unknown;
    readonly collectionFormat: unknown;
}

export interface NativeSourceNode {
    readonly raw: unknown;
    readonly node: Readonly<Record<string, unknown>>;
    readonly pointer: string;
    readonly resolvedPointer: string;
}

export type NativeStringList =
    | { readonly state: "unspecified"; readonly values: readonly string[] }
    | {
        readonly state: "declared";
        readonly values: readonly string[];
        readonly node: unknown;
        readonly pointer: string;
        readonly level: "operation" | "path" | "root" | "content";
    };

export interface NativeMedia {
    readonly mediaType: string;
    readonly node: unknown;
    readonly pointer: string;
    // Keep declarations intact; selecting a media type resolves only its schema.
    readonly schema: NativeParameterSchema | undefined;
}

interface NativePayloadMedia {
    readonly dialect: NativeOpenApiDocument["dialect"];
    readonly mediaTypes: NativeStringList;
    readonly media: readonly NativeMedia[];
}

export type NativeRequestPayload = NativePayloadMedia & (
    | { readonly kind: "none"; readonly hasBody: false }
    | {
        readonly kind: "body";
        readonly hasBody: true;
        readonly body: NativeSourceNode;
        readonly required: boolean;
        readonly schema: NativeParameterSchema | undefined;
    }
    | { readonly kind: "formData"; readonly hasBody: true; readonly fields: readonly NativeParameter[] }
);

export interface NativeResponsePayload extends NativePayloadMedia {
    readonly kind: "response";
    readonly statusCode: string;
    readonly response: NativeSourceNode;
    readonly schema: NativeParameterSchema | undefined;
    readonly hasBody: boolean;
}

export type ContentTypeMatch = "match" | "mismatch" | "unknown";

export type NativeTransport =
    | { readonly kind: "unspecified" }
    | {
        readonly kind: "schemes";
        readonly declaration: Extract<NativeStringList, { state: "declared" }>;
    }
    | {
        readonly kind: "servers";
        readonly node: readonly unknown[];
        readonly pointer: string;
        readonly level: "operation" | "path" | "root";
        readonly servers: readonly {
            readonly node: Readonly<Record<string, unknown>>;
            readonly pointer: string;
            readonly url: string;
            readonly scheme: string | undefined;
        }[];
    };
