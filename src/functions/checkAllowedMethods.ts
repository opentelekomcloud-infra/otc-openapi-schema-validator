import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { operationRange } from "@/lib/openapi/sourceMap";

export function checkAllowedMethods(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const allowedMethods = rule.call.functionParams.methods.map((m: string) => m.toLowerCase());

    if (!spec || !spec.paths || !Array.isArray(allowedMethods)) {
        return diagnostics;
    }

    for (const pathKey in spec.paths) {
        const pathItem = spec.paths[pathKey];

        for (const method in pathItem) {
            const methodLower = method.toLowerCase();
            if (!allowedMethods.includes(methodLower)) {
                const { from: start, to: end } = operationRange(content, pathKey, method);
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: rule.message,
                    source: getSource(rule),
                });
            }
        }
    }

    return diagnostics;
}
