import { Diagnostic } from "@codemirror/lint";
import { resolveRefDeep } from "@/utils/schema";
import { dedupeDiagnostics, pushOperationDiagnostic } from "@/utils/diagnostic";
import { collectOperations } from "@/utils/spec";

type ScopeRuleConfig = {
    scopeField?: string;
    scopeTags?: {
        global?: string;
        regional?: string;
    };
    parameterName?: string;
    parameterLocation?: string;
    requireForRegional?: boolean;
    optionalForGlobal?: boolean;
    failWhenScopeTagMissing?: boolean;
};

type ScopeType = "global" | "regional" | "missing" | "conflict";

/**
 * Determines operation scope from configured tags.
 */
function detectScope(operation: any, cfg: ScopeRuleConfig): ScopeType {
    const scopeField = String(cfg.scopeField ?? "tags");
    const values = Array.isArray(operation?.[scopeField]) ? operation[scopeField] : [];
    const tags = values.map((v: any) => String(v).trim().toLowerCase());

    const globalTag = String(cfg.scopeTags?.global ?? "global").trim().toLowerCase();
    const regionalTag = String(cfg.scopeTags?.regional ?? "regional").trim().toLowerCase();

    const hasGlobal = tags.includes(globalTag);
    const hasRegional = tags.includes(regionalTag);

    if (hasGlobal && hasRegional) return "conflict";
    if (hasGlobal) return "global";
    if (hasRegional) return "regional";
    return "missing";
}

/**
 * Finds the configured parameter on path-item or operation level.
 * Local `$ref` parameters are resolved before comparison.
 */
function findScopedParameter(pathItem: any, operation: any, spec: any, cfg: ScopeRuleConfig): any | null {
    const targetName = String(cfg.parameterName ?? "project_id").trim();
    const targetLocation = String(cfg.parameterLocation ?? "path").trim().toLowerCase();

    const allParams = [
        ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
    ];

    for (const rawParam of allParams) {
        const param = resolveRefDeep(rawParam, new Map<string, any>(), spec);
        if (!param || typeof param !== "object") continue;

        const name = String((param as any).name ?? "").trim();
        const paramIn = String((param as any).in ?? "").trim().toLowerCase();

        if (name === targetName && paramIn === targetLocation) {
            return param;
        }
    }

    return null;
}

/**
 * ARG-040-01-2507-2507-O
 * project_id Path Parameter Scope Consistency.
 *
 * Validates that:
 * - regional operations require `project_id` path parameter and it must be required
 * - global operations may omit `project_id`, but if present it must not be required
 * - operations without configured scope tags are skipped unless explicitly configured otherwise
 */
export function checkProjectIdByTagScope(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const cfg = (rule?.call?.functionParams ?? {}) as ScopeRuleConfig;
    const operations = collectOperations(spec);

    for (const { path, method, operation, pathItem } of operations) {
        const scope = detectScope(operation, cfg);
        const param = findScopedParameter(pathItem, operation, spec, cfg);

        if (scope === "missing") {
            if (cfg.failWhenScopeTagMissing) {
                pushOperationDiagnostic(
                    diagnostics,
                    content,
                    path,
                    method,
                    rule,
                    `Could not determine scope because neither '${cfg.scopeTags?.global ?? "global"}' nor '${cfg.scopeTags?.regional ?? "regional"}' tag is present.`
                );
            }
            continue;
        }

        if (scope === "conflict") {
            pushOperationDiagnostic(
                diagnostics,
                content,
                path,
                method,
                rule,
                `Operation contains both '${cfg.scopeTags?.global ?? "global"}' and '${cfg.scopeTags?.regional ?? "regional"}' scope tags.`
            );
            continue;
        }

        if (scope === "regional") {
            if (cfg.requireForRegional !== false && !param) {
                pushOperationDiagnostic(
                    diagnostics,
                    content,
                    path,
                    method,
                    rule,
                    `Regional operation must define '${cfg.parameterName ?? "project_id"}' as '${cfg.parameterLocation ?? "path"}' parameter.`
                );
                continue;
            }

            if (param && (param as any).required !== true) {
                pushOperationDiagnostic(
                    diagnostics,
                    content,
                    path,
                    method,
                    rule,
                    `Regional operation must require '${cfg.parameterName ?? "project_id"}' path parameter.`
                );
            }

            continue;
        }

        if (scope === "global") {
            if (cfg.optionalForGlobal && param && (param as any).required === true) {
                pushOperationDiagnostic(
                    diagnostics,
                    content,
                    path,
                    method,
                    rule,
                    `Global operation must not require '${cfg.parameterName ?? "project_id"}' path parameter.`
                );
            }
        }
    }

    return dedupeDiagnostics(diagnostics);
}
