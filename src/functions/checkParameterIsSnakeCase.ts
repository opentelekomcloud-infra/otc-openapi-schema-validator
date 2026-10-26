import { Diagnostic } from "@codemirror/lint";
import {
    splitPathIntoTokens,
} from "@/utils/englishWords";
import { pushMethodDiagnostic, dedupeDiagnostics } from "@/utils/diagnostic";
import {SnakeCaseConfig, validateFieldNameTokens} from "@/utils/naming";
import type { NativeOperation } from "@/types/openapi";
import { isSwagger2Root } from "@/lib/openapi/media";
import { namingSchemas, schemaNameFields } from "@/utils/nativeNaming";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";
import { ruleOperations, ruleParameterNodes, ruleRequest } from "@/utils/nativeRule";
import { objectRange } from "@/lib/openapi/sourceMap";
import type { SourceRange } from "@/types/openapi";

interface LocatedProblem {
    readonly message: string;
    readonly location?: SourceRange;
}

function checkParameters(op: NativeOperation, spec: any, pathTokens: string[], cfg: SnakeCaseConfig, content: string): LocatedProblem[] {
    const problems: LocatedProblem[] = [];
    for (const { parameter: param } of ruleParameterNodes(op, spec, new Map())) {
        if (isSwagger2Root(spec) && (param.in === "body" || param.in === "formData")) continue;

        const name = String((param as any).name ?? "").trim();
        const paramIn = String((param as any).in ?? "").toLowerCase();
        if (!name || !paramIn) continue;

        // Header names follow HTTP header conventions and are validated by dedicated header rules,
        // so they must be excluded from the snake_case parameter rule.
        if (paramIn === "header") continue;

        const issues = validateFieldNameTokens(name, cfg, pathTokens);

        for (const issue of issues) {
            problems.push({ message: `Parameter '${name}' in '${paramIn}' is invalid. ${issue}`, location: objectRange(spec, content, param, "name", "value") });
        }
    }

    return problems;
}

function checkRequestBody(op: NativeOperation, spec: any, pathTokens: string[], cfg: SnakeCaseConfig, content: string): LocatedProblem[] {
    const problems: LocatedProblem[] = [];
    const cache = new Map<string, unknown>();
    const payload = ruleRequest(op, spec, cache);
    const fields = payload.kind === "formData"
        ? payload.fields.map((field) => ({
            name: field.name, location: objectRange(spec, content, field.parameter, "name", "value"),
        }))
        : namingSchemas(payload, spec, cache).flatMap((schema) => schemaNameFields(schema, spec, cache))
            .map((field) => ({ name: field.name, location: objectRange(spec, content, field.owner, field.name) }));
    for (const { name: fieldName, location } of fields) {
        const issues = validateFieldNameTokens(fieldName, cfg, pathTokens);
        for (const issue of issues) {
            problems.push({
                message: `Request body field '${fieldName}' is invalid. ${issue}`,
                location,
            });
        }
    }

    return problems;
}

function checkResponses(op: NativeOperation, spec: any, pathTokens: string[], cfg: SnakeCaseConfig, content: string): LocatedProblem[] {
    const problems: LocatedProblem[] = [];
    const cache = new Map<string, unknown>();
    for (const code of responseStatuses(op)) {
        const response = responseFor(op, code, spec, cache);
        for (const field of namingSchemas(response, spec, cache).flatMap((schema) => schemaNameFields(schema, spec, cache))) {
            const fieldName = field.name;
            const issues = validateFieldNameTokens(fieldName, cfg, pathTokens);
            for (const issue of issues) {
                problems.push({
                    message: `Response field '${fieldName}' in status '${code}' is invalid. ${issue}`,
                    location: objectRange(spec, content, field.owner, fieldName),
                });
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
    const operations = ruleOperations(spec, { methods: fp.methods ?? ["get", "post", "put", "patch", "delete"] });

    for (const op of operations) {
        const { path, method } = op;
        const pathTokens = splitPathIntoTokens(path);
        const problems: LocatedProblem[] = [];

        if (fp.checkRequestParameters !== false) {
            problems.push(...checkParameters(op, spec, pathTokens, fp, content));
        }

        if (fp.checkRequestBodyFields) {
            problems.push(...checkRequestBody(op, spec, pathTokens, fp, content));
        }

        if (fp.checkResponseBodyFields) {
            problems.push(...checkResponses(op, spec, pathTokens, fp, content));
        }

        for (const problem of problems) {
            pushMethodDiagnostic(diagnostics, content, path, method, rule, problem.message, problem.location);
        }
    }

    return dedupeDiagnostics(diagnostics);
}
