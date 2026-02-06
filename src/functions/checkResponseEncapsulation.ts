import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

export function checkResponseEncapsulation(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const responsesKey: string = rule.element;
    const methodsToCheck = (rule.call.functionParams.methods || []).map((m: string) => m.toLowerCase());
    const contentTypes = rule.call.functionParams.content || [];
    const excludeContent: string[] = Array.isArray(rule.call.functionParams.excludeContent)
        ? rule.call.functionParams.excludeContent.map((v: any) => String(v).trim()).filter(Boolean)
        : [];
    const headersKeys = rule.call.functionParams.headers || [];

    if (!spec?.paths || !Array.isArray(methodsToCheck)) return diagnostics;

    for (const pathKey in spec.paths) {
        const pathItem = spec.paths[pathKey];

        for (const method in pathItem) {
            if (!methodsToCheck.includes(method.toLowerCase())) continue;

            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            if (excludeContent.length > 0 && operation.requestBody) {
                const rb = operation.requestBody;
                // requestBody may be a $ref in some specs; best-effort handle plain objects only.
                const rbContent = (rb && typeof rb === "object") ? (rb as any).content : undefined;
                if (rbContent && typeof rbContent === "object") {
                    const rbMediaTypes = Object.keys(rbContent);
                    const rbExcluded = rbMediaTypes.some((mt) =>
                        excludeContent.some((ex) => ex.toLowerCase() === String(mt).toLowerCase())
                    );
                    if (rbExcluded) {
                        continue;
                    }
                }
            }

            const responses = operation[responsesKey];
            if (!responses || typeof responses !== "object") continue;

            for (const statusCode in responses) {
                const response = responses[statusCode];

                if (excludeContent.length > 0 && response?.content && typeof response.content === "object") {
                    const mediaTypes = Object.keys(response.content);
                    const isExcluded = mediaTypes.some((mt) =>
                        excludeContent.some((ex) => ex.toLowerCase() === String(mt).toLowerCase())
                    );
                    if (isExcluded) continue;
                }

                const contentObj = response.content || {};
                const contentBlock = Object.keys(contentObj);

                if (contentBlock.length === 0) {
                    continue;
                }

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
