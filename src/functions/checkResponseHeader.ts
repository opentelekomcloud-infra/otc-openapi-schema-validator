import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { findNextStatusCodeRange } from "@/utils/scan";

function isNonEmptyRecordOrMap(v: any): boolean {
  if (!v) return false;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object" && !Array.isArray(v)) return Object.keys(v).length > 0;
  return false;
}

function entriesOf(obj: any): Array<[string, any]> {
  if (!obj) return [];
  if (obj instanceof Map) return Array.from(obj.entries()).map(([k, v]) => [String(k), v]);
  if (typeof obj === "object") return Object.entries(obj).map(([k, v]) => [String(k), v]);
  return [];
}

function keysOf(obj: any): string[] {
  if (!obj) return [];
  if (obj instanceof Map) return Array.from(obj.keys()).map((k) => String(k));
  if (typeof obj === "object") return Object.keys(obj);
  return [];
}

/**
 * HDR-020-01-2507-2507-M-2
 * X-Request-Id Header Validation for Response.
 *
 * If a response contains the property specified by `rule.call.functionParams.ifPropertyExists`
 * (default: "content") and that property is a non-empty object, then the response must contain
 * a `headers` block with at least ONE header from `rule.call.functionParams.headers`.
 *
 * Notes:
 * - If the property does not exist (or is empty), the rule does not apply to that response.
 */
export function checkResponseHeader(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const params = rule?.call?.functionParams ?? {};

  const ifPropertyExists: string = typeof params.ifPropertyExists === "string" && params.ifPropertyExists.trim()
    ? params.ifPropertyExists.trim()
    : "content";

  const requiredAnyHeaders: string[] = Array.isArray(params.headers)
    ? params.headers.map((h: any) => String(h)).filter(Boolean)
    : [];

  if (!spec || requiredAnyHeaders.length === 0) return diagnostics;
  // Depending on the engine integration, `spec` may be the full OpenAPI document
  // OR already the `paths` object. Support both.
  const pathsObject = (spec as any).paths ?? spec;
  if (!pathsObject || (typeof pathsObject !== "object" && !(pathsObject instanceof Map))) return diagnostics;

  const requiredLower = new Set(requiredAnyHeaders.map((h) => h.toLowerCase()));
  // Used to locate response status-code keys in the raw spec in a stable way.
  let statusCursor = 0;

  for (const [, pathItem] of entriesOf(pathsObject)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const [method, operation] of entriesOf(pathItem)) {
      if (method === "parameters") continue;
      if (!operation || typeof operation !== "object") continue;

      const responses = (operation as any).responses;
      if (!responses || (typeof responses !== "object" && !(responses instanceof Map))) continue;

      for (const [statusCode, response] of entriesOf(responses)) {
        if (!response || typeof response !== "object") continue;

        const triggerProp = (response as any)[ifPropertyExists];
        const triggerApplies = isNonEmptyRecordOrMap(triggerProp);

        if (!triggerApplies) continue;

        const headersBlock = (response as any).headers;
        const headerNames = keysOf(headersBlock);

        const hasAnyRequired = headerNames.some((hn) => requiredLower.has(String(hn).toLowerCase()));

        // Compute a stable highlight range for this response code (one-by-one).
        const range = findNextStatusCodeRange(content, String(statusCode), statusCursor);
        if (range.to > 0) {
          const nl = content.indexOf("\n", range.to);
          statusCursor = nl === -1 ? content.length : nl + 1;
        }

        // Only trigger diagnostic if NONE of the allowed headers are present.
        if (!headersBlock || !hasAnyRequired) {
          diagnostics.push({
            from: range.from,
            to: range.to,
            severity: mapSeverity(rule?.severity),
            message:
              `${rule?.message ?? "Missing required response header."} ` +
              `Expected at least one of [${requiredAnyHeaders.join(", ")}] in response headers when '${ifPropertyExists}' exists.`,
            source: getSource(rule),
          });
        }
      }
    }
  }

  return diagnostics;
}
