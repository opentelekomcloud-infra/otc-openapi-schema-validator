import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { appendPointer, isRecord, jsonPointer, resolveObjectReference } from "@/lib/openapi/references";
import { getResponsePayload } from "@/lib/openapi/payloads";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { ruleDiagnostic, ruleOperations, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkResponseHeader(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
  // Retain the explicit legacy paths/Map API; runtime documents use native body descriptors below.
  const legacyPaths = spec instanceof Map || (isRecord(spec) && (spec.paths instanceof Map ||
    (!Object.hasOwn(spec, "paths") && Object.keys(spec).some((key) => key.startsWith("/")))));
  if (legacyPaths) return checkLegacyResponseHeader(spec, content, rule);
  const params = rule.call.functionParams ?? {};
  if (params.ifPropertyExists !== undefined && typeof params.ifPropertyExists !== "string") {
    throw new Error("functionParams.ifPropertyExists must be a string.");
  }
  const trigger = typeof params.ifPropertyExists === "string" && params.ifPropertyExists.trim()
    ? params.ifPropertyExists.trim() : "content";
  const required = ruleStrings(params.headers, "headers");
  if (!required.length) throw new Error("functionParams.headers must not be empty.");
  const allowed = new Set(required.map((name) => name.toLowerCase()));
  const diagnostics: Diagnostic[] = [];
  const cache = new Map<string, unknown>();
  for (const op of ruleOperations(spec, params)) {
    if (op.operation.responses === undefined) continue;
    if (!isRecord(op.operation.responses)) {
      throw new NativeAccessorError("INVALID_DECLARATION", op.pointer, "Expected a responses object");
    }
    for (const [status, raw] of Object.entries(op.operation.responses)) {
      if (status.startsWith("x-")) continue;
      const pointer = appendPointer(op.pointer, "responses", status);
      const response = resolveObjectReference(raw, spec, cache, pointer);
      if (!response) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a response object");
      const applies = trigger === "content"
        ? getResponsePayload(op.operation, status, spec, cache, op.pointer)?.hasBody
        : isNonEmptyRecordOrMap(response.value[trigger]);
      if (!applies) continue;
      const headers = response.value.headers;
      if (headers !== undefined && !isRecord(headers)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(response.pointer, "headers"), "Expected a headers object");
      }
      if (!Object.keys(headers ?? {}).some((name) => allowed.has(name.toLowerCase()))) {
        diagnostics.push(ruleDiagnostic(content, rule, response.pointer,
          `Expected at least one of [${required.join(", ")}] in response headers when '${trigger}' exists.`));
      }
    }
  }
  return diagnostics;
}

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
function checkLegacyResponseHeader(spec: any, content: string, rule: any): Diagnostic[] {
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
  for (const [path, pathItem] of entriesOf(pathsObject)) {
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

        const range = sourceMap(content).locate(jsonPointer(["paths", path, method, "responses", statusCode]));

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
