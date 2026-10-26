import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { schemaHasPropertyDeep } from "@/utils/schema";
import type { NativeOperation } from "@/types/openapi";
import { selectPayloadSchema } from "@/lib/openapi/payloads";
import { responseFor } from "@/utils/nativeResponse";
import { ruleOperations, ruleParameterNodes } from "@/utils/nativeRule";

/**
 * Collects effective path parameter names as authored; schema lookup retains its case-insensitive fallback.
 * `$ref` parameters are resolved.
 */
function collectPathParamNames(op: NativeOperation, spec: any, refCache: Map<string, any>): string[] {
  const names: string[] = [];

  for (const { parameter: param } of ruleParameterNodes(op, spec, refCache)) {
    const inVal = String(param.in ?? "").toLowerCase();
    if (inVal !== "path") continue;

    const name = String(param.name ?? "");
    if (!name) continue;

    names.push(name);
  }

  // Deduplicate preserving order
  return Array.from(new Set(names));
}

/**
 * FIL-010-01-2507-2507-O
 * Filter Parameter Check.
 *
 * For selected HTTP methods (default GET), this rule ensures that all `in: path`
 * parameters declared for an operation are represented somewhere in the successful
 * 200 response schema.
 *
 * The 200 response schema may be inline or referenced via `$ref`. The rule resolves
 * references and traverses nested objects/arrays/composition (`allOf`/`oneOf`/`anyOf`).
 *
 * Behavior is controlled via `rule.call.functionParams`:
 * - methods: string[]
 *   HTTP methods to validate (default: ["get"]).
 */
export function checkURIFilterParams(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths) return diagnostics;

  const fp = rule?.call?.functionParams ?? {};
  const methodsToCheck: string[] = Array.isArray(fp.methods)
    ? fp.methods.map((m: any) => String(m).toLowerCase())
    : ["get"];

  for (const op of ruleOperations(spec, methodsToCheck.length ? { methods: methodsToCheck } : {})) {
    const { path, method } = op;
    const pathParamNames = collectPathParamNames(op, spec, refCache);
    if (pathParamNames.length === 0) continue;
    const schemaResp = selectPayloadSchema(responseFor(op, "200", spec, refCache),
      ["application/json", "application/problem+json"], spec, refCache);
    if (!schemaResp) continue;
    const missing = pathParamNames.filter((name) =>
      !schemaHasPropertyDeep(schemaResp.node, name, spec, refCache, new Set<object>()));
    if (missing.length === 0) continue;
    const { start, end } = findMethodParametersPositionInYaml(content, path, method);
    diagnostics.push({
      from: start,
      to: end,
      severity: mapSeverity(rule.severity),
      message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message}. Missing in response schema: ${missing.join(", ")}.`,
      source: getSource(rule),
    });
  }

  return diagnostics;
}
