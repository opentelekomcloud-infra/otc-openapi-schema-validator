import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer } from "@/lib/openapi/references";

/**
 * COD-040-01-2507-2507-M
 * Response Body JSON, BSON, XML or Octet-Stream Encapsulation.
 *
 * This rule verifies that response bodies for selected HTTP methods
 * (e.g. POST, PUT, DELETE) use one of the allowed encapsulation formats.
 *
 * If a response contains a body (`response.content` is defined and non-empty),
 * then at least one of the configured media types must be present
 * (e.g. application/json or application/bson).
 *
 * Additionally, when headers are configured (e.g. Content-Type),
 * the rule ensures that required headers are present in the response
 * and correspond to the supported encapsulation formats.
 *
 * Behavior is controlled via `rule.call.functionParams`:
 * - methods: string[]
 *   HTTP methods to validate (case-insensitive).
 * - content: string[]
 *   Allowed media types for response body encapsulation.
 * - excludeContent: string[]
 *   Media types that are excluded from validation.
 * - headers: string[]
 *   Required response headers (e.g. Content-Type).
 *
 * The rule traverses:
 * - spec.paths -> path -> method -> responses -> statusCode
 */
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
            if (!pathItem || typeof pathItem !== "object") continue;
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
                    const { from, to } = sourceMap(content).locate(jsonPointer(["paths", pathKey, method, responsesKey, statusCode]));

                    diagnostics.push({
                      from,
                      to,
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
