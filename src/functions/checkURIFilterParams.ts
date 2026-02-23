import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { resolveRefDeep, schemaHasPropertyDeep } from "@/utils/schema";

/**
 * Extracts a response schema for code 200 from an operation.
 * Supports both numeric and string status keys (200 / "200") and `$ref` responses.
 */
function getResponseSchema(operation: any, spec: any, refCache: Map<string, any>): any | null {
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return null;

  const respRaw = (responses as any)["200"] ?? (responses as any)[200];
  if (!respRaw) return null;

  const resp = resolveRefDeep(respRaw, refCache, spec);
  return extractResponseSchemaFromResponseObject(resp, spec, refCache);
}

/**
 * Extracts the schema object from an OpenAPI Response object.
 * Prefers `content[*].schema`, falling back to `schema` (OAS2-style).
 */
function extractResponseSchemaFromResponseObject(responseObj: any, spec: any, refCache: Map<string, any>): any | null {
  if (!responseObj || typeof responseObj !== "object") return null;

  const contentObj = (responseObj as any).content;
  if (contentObj && typeof contentObj === "object") {
    const mediaTypes = Object.keys(contentObj);
    if (mediaTypes.length === 0) return null;

    const preferred =
      (contentObj as any)["application/json"] ??
      (contentObj as any)["application/problem+json"] ??
      (contentObj as any)[mediaTypes[0]];

    const schema = preferred?.schema;
    if (!schema) return null;
    return resolveRefDeep(schema, refCache, spec);
  }

  // Some specs still place schema directly under the response.
  const schemaDirect = (responseObj as any).schema;
  if (schemaDirect) return resolveRefDeep(schemaDirect, refCache, spec);

  return null;
}

/**
 * Collects `in: path` parameter names (case-sensitive as authored, compared case-sensitively).
 * `$ref` parameters are resolved.
 */
function collectPathParamNames(allParams: any[], spec: any, refCache: Map<string, any>): string[] {
  const names: string[] = [];

  for (const p of allParams) {
    const param = resolveRefDeep(p, refCache, spec);
    if (!param || typeof param !== "object") continue;

    const inVal = String((param as any).in ?? "").toLowerCase();
    if (inVal !== "path") continue;

    const name = String((param as any).name ?? "");
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

  for (const path in spec.paths) {
    const pathItem = spec.paths[path];
    if (!pathItem || typeof pathItem !== "object") continue;

    const methodKeys = methodsToCheck.length > 0
      ? methodsToCheck
      : Object.keys(pathItem).map((m) => String(m).toLowerCase());

    for (const method of methodKeys) {
      const operation = (pathItem as any)[method];
      if (!operation || typeof operation !== "object") continue;

      const opParams = Array.isArray(operation.parameters) ? operation.parameters : [];
      const pathParams = Array.isArray((pathItem as any).parameters) ? (pathItem as any).parameters : [];
      const allParams = [...pathParams, ...opParams];

      const pathParamNames = collectPathParamNames(allParams, spec, refCache);
      if (pathParamNames.length === 0) continue;

      const schemaResp = getResponseSchema(operation, spec, refCache);
      if (!schemaResp) {
        // No schema to check against; do not emit a diagnostic.
        continue;
      }

      const missing: string[] = [];
      for (const pName of pathParamNames) {
        const ok = schemaHasPropertyDeep(schemaResp, pName, spec, refCache, new Set<any>());
        if (!ok) missing.push(pName);
      }

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
  }

  return diagnostics;
}
