import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { findSchemaPropertyDeep } from "@/utils/schema";
import type { NativeOperation } from "@/types/openapi";
import { selectPayloadSchema } from "@/lib/openapi/payloads";
import { responseFor } from "@/utils/nativeResponse";
import { ruleOperations } from "@/utils/nativeRule";
import { queryParameters } from "@/utils/nativeQuery";

const nonFilterParameters = new Set(["offset", "limit", "marker", "sort_key", "sort_dir"]);

/**
 * Preserve authored filter names after resolving inherited/reusable query parameters.
 */
function collectFilterParamNames(op: NativeOperation, spec: any, refCache: Map<string, any>): string[] {
  const names = queryParameters(op, spec, refCache)
    .filter(({ name }) => !nonFilterParameters.has(name))
    .map(({ parameter }) => String(parameter.name));
  return Array.from(new Set(names));
}

/**
 * FIL-010-01-2507-2507-O
 * Filter Parameter Check.
 *
 * For selected HTTP methods (default GET), response fields representing query
 * filters must use the same names. Absent fields are allowed; only case and
 * underscore/hyphen spelling variants are recognized as equivalent fields.
 * URI parameters and standard pagination/sorting controls are not filters.
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
    const filterParamNames = collectFilterParamNames(op, spec, refCache);
    if (filterParamNames.length === 0) continue;
    const schemaResp = selectPayloadSchema(responseFor(op, "200", spec, refCache),
      ["application/json", "application/problem+json"], spec, refCache);
    if (!schemaResp) continue;
    const mismatches: string[] = [];
    for (const name of filterParamNames) {
      const exact = findSchemaPropertyDeep(schemaResp.node, (field) => field === name, spec, refCache, new Set<object>());
      if (exact !== undefined) continue;
      const normalized = name.replace(/[_-]/g, "").toLowerCase();
      const variant = findSchemaPropertyDeep(schemaResp.node,
        (field) => field.replace(/[_-]/g, "").toLowerCase() === normalized, spec, refCache, new Set<object>());
      if (variant !== undefined) mismatches.push(`'${variant}' must be named '${name}'`);
    }
    if (mismatches.length === 0) continue;
    const { start, end } = findMethodParametersPositionInYaml(content, path, method);
    diagnostics.push({
      from: start,
      to: end,
      severity: mapSeverity(rule.severity),
      message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message} Response field naming mismatch: ${mismatches.join("; ")}.`,
      source: getSource(rule),
    });
  }

  return diagnostics;
}
