import { Diagnostic } from "@codemirror/lint";
import {
    splitPathIntoTokens,
} from "@/utils/englishWords";
import { pushMethodDiagnostic, dedupeDiagnostics } from "@/utils/diagnostic";
import {
    resolveRefDeep,
    collectSchemaPaths,
    extractFieldNameFromSchemaPath,
    shouldIgnoreFieldPath
} from "@/utils/schema";
import {SnakeCaseConfig, validateFieldNameTokens} from "@/utils/naming";
import {collectOperationMethods} from "@/utils/scan";

function checkParameters(operation: any, pathItem: any, spec: any, pathTokens: string[], cfg: SnakeCaseConfig): string[] {
    const problems: string[] = [];
    const allParams = [
        ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
    ];

    for (const rawParam of allParams) {
        const param = resolveRefDeep(rawParam, new Map<string, any>(), spec);
        if (!param || typeof param !== "object") continue;

        const name = String((param as any).name ?? "").trim();
        const paramIn = String((param as any).in ?? "").toLowerCase();
        if (!name || !paramIn) continue;

        // Header names follow HTTP header conventions and are validated by dedicated header rules,
        // so they must be excluded from the snake_case parameter rule.
        if (paramIn === "header") continue;

        const issues = validateFieldNameTokens(name, cfg, pathTokens);

        for (const issue of issues) {
            problems.push(`Parameter '${name}' in '${paramIn}' is invalid. ${issue}`);
        }
    }

    return problems;
}

function checkRequestBody(operation: any, spec: any, pathTokens: string[], cfg: SnakeCaseConfig): string[] {
    const problems: string[] = [];
    const schema = resolveRefDeep(operation?.requestBody?.content?.["application/json"]?.schema, new Map<string, any>(), spec)
        ?? resolveRefDeep(operation?.requestBody?.content?.[Object.keys(operation?.requestBody?.content ?? {})[0]]?.schema, new Map<string, any>(), spec);

    if (!schema) return problems;

    const schemaPaths = collectSchemaPaths(schema, spec, new Map<string, any>());
    for (const path of schemaPaths) {
        if (shouldIgnoreFieldPath(path)) continue;
        const fieldName = extractFieldNameFromSchemaPath(path);
        if (!fieldName) continue;

        const issues = validateFieldNameTokens(fieldName, cfg, pathTokens);
        for (const issue of issues) {
            problems.push(`Request body field '${fieldName}' is invalid. ${issue}`);
        }
    }

    return problems;
}

function checkResponses(operation: any, spec: any, pathTokens: string[], cfg: SnakeCaseConfig): string[] {
    const problems: string[] = [];
    const responses = operation?.responses;
    if (!responses || typeof responses !== "object") return problems;

    for (const code of Object.keys(responses)) {
        const response = resolveRefDeep(responses[code], new Map<string, any>(), spec);
        const contentObj = response?.content;
        if (!contentObj || typeof contentObj !== "object") continue;

        const firstMediaType = Object.keys(contentObj)[0];
        const schema = resolveRefDeep(contentObj?.["application/json"]?.schema, new Map<string, any>(), spec)
            ?? resolveRefDeep(contentObj?.[firstMediaType]?.schema, new Map<string, any>(), spec);
        if (!schema) continue;

        const schemaPaths = collectSchemaPaths(schema, spec, new Map<string, any>());
        for (const path of schemaPaths) {
            if (shouldIgnoreFieldPath(path)) continue;
            const fieldName = extractFieldNameFromSchemaPath(path);
            if (!fieldName) continue;

            const issues = validateFieldNameTokens(fieldName, cfg, pathTokens);
            for (const issue of issues) {
                problems.push(`Response field '${fieldName}' in status '${code}' is invalid. ${issue}`);
            }
        }
    }

    return problems;
}

/**
 * ARG-010-01-2507-2509-M
 * Request and Response Parameter Naming Convention.
 *
 * Validates that request parameters and request/response body field names:
 * - use snake_case
 * - are lowercase
 * - use valid English words or approved abbreviations when configured
 */
export function checkParameterIsSnakeCase(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const fp = (rule?.call?.functionParams ?? {}) as SnakeCaseConfig;
    const operations = collectOperationMethods(spec, fp.methods);

    for (const { path, method, operation, pathItem } of operations) {
        const pathTokens = splitPathIntoTokens(path);
        const problems: string[] = [];

        if (fp.checkRequestParameters !== false) {
            problems.push(...checkParameters(operation, pathItem, spec, pathTokens, fp));
        }

        if (fp.checkRequestBodyFields) {
            problems.push(...checkRequestBody(operation, spec, pathTokens, fp));
        }

        if (fp.checkResponseBodyFields) {
            problems.push(...checkResponses(operation, spec, pathTokens, fp));
        }

        for (const problem of problems) {
            pushMethodDiagnostic(diagnostics, content, path, method, rule, problem);
        }
    }

    return dedupeDiagnostics(diagnostics);
}
