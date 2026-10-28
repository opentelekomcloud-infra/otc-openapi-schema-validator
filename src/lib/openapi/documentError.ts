import type { Diagnostic } from "@codemirror/lint";
import type { SourceRange } from "@/types/openapi";

export type NativeOpenApiErrorCode =
    | "INVALID_INPUT"
    | "INVALID_SYNTAX"
    | "INVALID_DOCUMENT"
    | "NON_JSON_VALUE"
    | "MISSING_VERSION"
    | "CONFLICTING_VERSIONS"
    | "UNSUPPORTED_VERSION";

interface ErrorDetails {
    readonly range?: SourceRange;
    readonly versionKey?: "swagger" | "openapi";
    readonly cause?: unknown;
}

export class NativeOpenApiError extends Error {
    readonly statusCode = 400;
    readonly source: "parser" | "version";
    readonly range: SourceRange;
    readonly versionKey?: "swagger" | "openapi";
    readonly cause?: unknown;

    constructor(readonly code: NativeOpenApiErrorCode, message: string, details: ErrorDetails = {}) {
        super(message);
        this.name = "NativeOpenApiError";
        this.range = details.range ?? { from: 0, to: 0 };
        this.versionKey = details.versionKey;
        this.cause = details.cause;
        this.source = ["MISSING_VERSION", "CONFLICTING_VERSIONS", "UNSUPPORTED_VERSION"].includes(code)
            ? "version" : "parser";
    }

    toDiagnostic(): Diagnostic {
        return { ...this.range, severity: "error", message: this.message, source: this.source };
    }
}
