import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer } from "@/lib/openapi/references";

export function checkRequestEncapsulation(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const requestBodyKey: string = rule.element;
    const contentTypes: string[] = rule.call.functionParams.content || [];

    if (!spec?.paths) return diagnostics;

    for (const pathKey in spec.paths) {
        const pathItem = spec.paths[pathKey];

        for (const method in pathItem) {
            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            const requestBody = operation[requestBodyKey];
            if (!requestBody || typeof requestBody !== "object") continue;

            const contentKeys = Object.keys(requestBody.content || {});
            const hasRequiredContentType = contentTypes.some(type => contentKeys.includes(type));

            if (!hasRequiredContentType) {
                const { from: start, to: end } = sourceMap(content).locate(jsonPointer(["paths", pathKey, method, requestBodyKey]));
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
