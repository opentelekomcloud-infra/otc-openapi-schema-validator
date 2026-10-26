import type { Diagnostic } from "@codemirror/lint";
import type { AutoRule } from "@/lib/linter/ruleCatalog";
import type { NativeOpenApiDocument } from "@/types/openapi";
import { getSource } from "@/functions/common";
import { NativeOpenApiError } from "@/lib/openapi/documentError";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import { jsonPointer } from "@/lib/openapi/references";
import { sourceMap, type SourceLocation } from "@/lib/openapi/sourceMap";
import { mapSeverity } from "@/utils/mapSeverity";

export type ComplianceRule = Pick<AutoRule, "id" | "title" | "message" | "severity" | "call">;

export function complianceDiagnostic(
    content: string, rule: ComplianceRule, details: string,
    location: string | SourceLocation = "#", kind: "key" | "value" = "key",
): Diagnostic {
    return {
        ...(typeof location === "string" ? sourceMap(content).locate(location, kind) : location),
        severity: mapSeverity(rule.severity),
        message: `'${rule.message}' ${details}`,
        source: getSource(rule),
    };
}

export function classifyForCompliance(spec: unknown, content: string, rule: ComplianceRule):
    { ok: true; native: NativeOpenApiDocument } | { ok: false; diagnostic: Diagnostic } {
    try {
        return { ok: true, native: classifyNativeOpenApiDocument(spec) };
    } catch (error: unknown) {
        if (!(error instanceof NativeOpenApiError)) throw error;
        const details = error.code === "UNSUPPORTED_VERSION"
            ? `'${error.versionKey}' version is not allowed. ${error.message}` : error.message;
        return {
            ok: false,
            diagnostic: complianceDiagnostic(
                content, rule, details, error.versionKey ? jsonPointer([error.versionKey]) : "#",
                error.versionKey ? "value" : "key",
            ),
        };
    }
}

export function complianceStringList(value: unknown, name: string): readonly string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
        throw new Error(`Compliance functionParams.${name} must be an array of strings.`);
    }
    return value;
}
