import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

export function checkResponseEncapsulation(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const responsesKey: string = rule.element;
    const methodsToCheck = (rule.call.functionParams.methods || []).map((m: string) => m.toLowerCase());
    const contentTypes = rule.call.functionParams.content || [];
    const headersKeys = rule.call.functionParams.headers || [];

    if (!spec?.paths || !Array.isArray(methodsToCheck)) return diagnostics;

    for (const pathKey in spec.paths) {
        const pathItem = spec.paths[pathKey];

        for (const method in pathItem) {
            if (!methodsToCheck.includes(method.toLowerCase())) continue;

            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            const responses = operation[responsesKey];
            if (!responses || typeof responses !== "object") continue;

            for (const statusCode in responses) {
                const response = responses[statusCode];

                const contentBlock = Object.keys(response.content || {});
                const hasValidContentType = contentTypes.some((type: string) => contentBlock.includes(type));

                const headersBlock = response.headers || {};
                const hasValidHeader = Object.keys(headersBlock).length === 0 || headersKeys.every((header: PropertyKey) => Object.hasOwn(headersBlock, header));

                if (!hasValidContentType || (headersKeys.length > 0 && Object.keys(headersBlock).length > 0 && !hasValidHeader)) {
                    const pathStart = content.indexOf(pathKey);
                    const methodBlockStart = content.indexOf(`${method}:`, pathStart);
                    const responsesKeyIndex = content.indexOf(`${responsesKey}:`, methodBlockStart);
                    const start = responsesKeyIndex >= 0 ? responsesKeyIndex : methodBlockStart;
                    const end = start + `${responsesKey}:`.length;
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
    }

    return diagnostics;
}