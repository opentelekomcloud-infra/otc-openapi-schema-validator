import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findParameterPositionInYaml } from "@/utils/pos";
import { matchParameterSchema } from "@/utils/schema";

export function checkElementSensitiveData(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec?.paths) return diagnostics;

    const forbiddenKeys = rule.call.functionParams.queryNotAllowed;
    const paramIn = rule.element;
    const valueType = rule.call.functionParams.valueType || "string";

    for (const path in spec.paths) {
        const pathItem = spec.paths[path];

        const methodsToCheck = rule.call.functionParams.methods || Object.keys(pathItem);
        for (const method of methodsToCheck) {
            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            const parameters = operation.parameters || [];
            for (const key of forbiddenKeys) {
                const found = parameters.find((param: any) =>
                    matchParameterSchema(param, key, paramIn, valueType, spec)
                );

                if (found) {
                    const { start, end } = findParameterPositionInYaml(content, path, method, key);
                    diagnostics.push({
                        from: start,
                        to: end,
                        severity: mapSeverity(rule.severity),
                        message: rule.message,
                        source: rule.id,
                    });
                    break;
                }
            }
        }
    }

    return diagnostics;
}
