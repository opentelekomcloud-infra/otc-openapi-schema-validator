import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";

export function checkParamElementPresence(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const name = rule.call.functionParams.name;
    const type = rule.call.functionParams.valueType;
    const where = rule.call.functionParams.in;

    if (!spec?.paths) return diagnostics;

    const seen = new Set<string>();

    for (const path in spec.paths) {
        const pathItem = spec.paths[path];

        for (const method in pathItem) {
            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            const key = `${path}|${method}`;
            if (seen.has(key)) continue;

            const parameters = operation.parameters || [];

            const found = parameters.some((param: any) =>
                param.name === name &&
                param.in === where &&
                param.schema?.type === type
            );

            if (!found) {
                seen.add(key);
                const { start, end } = findMethodPositionInYaml(content, path, method);
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: rule.message,
                    source: rule.id,
                });
            }
        }
    }

    return diagnostics;
}