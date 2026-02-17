import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";

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
                    // Prefer YAML-anchored searches to avoid matching path/method text in other places.
                    const pathAnchor = `  ${pathKey}:`;
                    const pathStart = content.indexOf(pathAnchor);
                    if (pathStart < 0) continue;

                    const methodAnchor = `    ${method}:`;
                    const methodBlockStart = content.indexOf(methodAnchor, pathStart);
                    if (methodBlockStart < 0) continue;

                    const responsesAnchor = `      ${responsesKey}:`;
                    const responsesKeyIndex = content.indexOf(responsesAnchor, methodBlockStart);
                    if (responsesKeyIndex < 0) continue;

                    const range = findStatusCodeRange(content, responsesKeyIndex, String(statusCode));
                    const from = range?.from ?? responsesKeyIndex;
                    const to = range?.to ?? (responsesKeyIndex + responsesAnchor.length);

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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findStatusCodeRange(content: string, responsesKeyIndex: number, statusCode: string): { from: number; to: number } | null {
  if (responsesKeyIndex < 0) return null;
  const slice = content.slice(responsesKeyIndex);
  // Match both quoted and unquoted YAML keys: "200": or 202:
  const re = new RegExp(`^([\\t ]*)(["']?)(${escapeRegExp(statusCode)})\\2\\s*:`, "m");
  const m = re.exec(slice);
  if (!m) return null;

  const indentLen = m[1].length;
  const quote = m[2] ?? "";
  const codeLen = (m[3] ?? "").length;

  const from = responsesKeyIndex + m.index + indentLen;
  const to = from + quote.length + codeLen + quote.length;
  return { from, to };
}
