import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import { getSource } from "@/functions/common";

export function checkSuccessResponse(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const method: string[] = rule.call.functionParams.method || "get";
    const requiredStatusCode: string[] = rule.call.functionParams.requiredStatusCode || "200";

    if (!spec?.paths) return diagnostics;

    for (const path in spec.paths) {
        const pathItem = spec.paths[path];

        for (const op in pathItem) {
            if (!Array.isArray(method) ? op !== method : !method.includes(op)) continue;

            const operation = pathItem[op];
            if (!operation || typeof operation !== "object") continue;

            const responses = operation.responses || {};
            const codes = Array.isArray(requiredStatusCode) ? requiredStatusCode : [requiredStatusCode];

            const missingCodes = codes.filter(code => !(code in responses));
            if (missingCodes.length > 0) {
                const { start: from, end: to } = findMethodPositionInYaml(content, path, op);

                diagnostics.push({
                    from,
                    to,
                    severity: mapSeverity(rule.severity),
                    message: `${rule.message} Missing: ${missingCodes.join(", ")}`,
                    source: getSource(rule),
                });
            }
        }
    }

    return diagnostics;
}
