import { Diagnostic } from "@codemirror/lint";
import { collectDocumentPathEntries } from "@/lib/openapi/paths";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { appendPointer, isRecord, jsonPointer } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { matchesMediaType, parseDeclaredMediaType, type DeclaredMediaType } from "@/utils/mediaType";
import { ruleDiagnostic, ruleOperations, ruleRequest, ruleStrings, type NativeRule } from "@/utils/nativeRule";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";

export function checkResponseEncapsulation(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    if (rule.element !== undefined && typeof rule.element !== "string") {
        throw new Error("Response body rule.element must be a string.");
    }
    if (typeof rule.element === "string" && rule.element !== "responses") {
        return checkLegacyResponseEncapsulation(spec, content, rule);
    }
    const params = rule.call.functionParams ?? {};
    const allowed = ruleStrings(params.content, "content").map((type) => parseDeclaredMediaType(type, "#"));
    if (!allowed.length) throw new Error("functionParams.content must not be empty.");
    const excluded = ruleStrings(params.excludeContent, "excludeContent").map((type) => parseDeclaredMediaType(type, "#"));
    const headers = ruleStrings(params.headers, "headers");
    const matches = (types: readonly DeclaredMediaType[], patterns: readonly DeclaredMediaType[]) =>
        types.some((type) => patterns.some((pattern) => matchesMediaType(type, pattern)));
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, params.methods === undefined ? { ...params, methods: [] } : params)) {
        if (excluded.length) {
            const request = ruleRequest(op, spec, cache);
            if (request.hasBody && matches(request.media.map((entry) =>
                parseDeclaredMediaType(entry.mediaType, entry.pointer)), excluded)) continue;
        }
        for (const status of responseStatuses(op)) {
            const response = responseFor(op, status, spec, cache);
            if (!response?.hasBody) continue;
            const media = response.media.map((entry) => parseDeclaredMediaType(entry.mediaType, entry.pointer));
            if (matches(media, excluded)) continue;
            let hasHeaders = true;
            if (headers.length && response.response.node.headers !== undefined) {
                const block = response.response.node.headers;
                if (!isRecord(block)) {
                    throw new NativeAccessorError("INVALID_DECLARATION",
                        appendPointer(response.response.resolvedPointer, "headers"), "Expected a headers object");
                }
                hasHeaders = !Object.keys(block).length || headers.every((name) => Object.hasOwn(block, name));
            }
            if (!matches(media, allowed) || !hasHeaders) {
                diagnostics.push(ruleDiagnostic(content, rule, response.response.resolvedPointer));
            }
        }
    }
    return diagnostics;
}

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
 * Explicit legacy header constraints apply only when a non-empty
 * response headers block is present. Native defaults validate media declarations.
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
function checkLegacyResponseEncapsulation(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const responsesKey: string = rule.element;
    const methodsToCheck = (rule.call.functionParams.methods || []).map((m: string) => m.toLowerCase());
    const contentTypes = rule.call.functionParams.content || [];
    const excludeContent: string[] = Array.isArray(rule.call.functionParams.excludeContent)
        ? rule.call.functionParams.excludeContent.map((v: any) => String(v).trim()).filter(Boolean)
        : [];
    const headersKeys = rule.call.functionParams.headers || [];

    if (!spec?.paths || !Array.isArray(methodsToCheck)) return diagnostics;

    for (const [pathKey] of collectDocumentPathEntries(spec)) {
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
