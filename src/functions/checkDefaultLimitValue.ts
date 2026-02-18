import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { resolveRefDeep } from "@/utils/schema";

export function checkDefaultLimitValue(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths) return diagnostics;

  const params = rule?.call?.functionParams ?? {};
  const methodsToCheck: string[] = Array.isArray(params.methods)
    ? params.methods.map((m: any) => String(m).toLowerCase())
    : [];

  const defaultValue = params.defaultValue;

  // Only enforce when a default is provided
  if (defaultValue === undefined || defaultValue === null) return diagnostics;

  for (const path in spec.paths) {
    const pathItem = spec.paths[path];
    if (!pathItem || typeof pathItem !== "object") continue;

    const methodKeys = methodsToCheck.length > 0 ? methodsToCheck : Object.keys(pathItem).map((m) => String(m).toLowerCase());

    for (const method of methodKeys) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];

      // Find a query parameter named "limit" (case-insensitive).
      // If it exists, it MUST define the configured default value.
      let hasLimit = false;
      let hasInvalidDefault = false;

      for (const p of parameters) {
        const param = resolveRefDeep(p, refCache, spec);
        if (!param || typeof param !== "object") continue;

        const name = String((param as any).name ?? "").toLowerCase();
        const inVal = String((param as any).in ?? "").toLowerCase();

        if (inVal !== "query" || name !== "limit") continue;

        hasLimit = true;

        const actualDefault =
          (param as any)?.schema?.default ??
          (param as any)?.default;

        if (actualDefault === undefined || String(actualDefault) !== String(defaultValue)) {
          hasInvalidDefault = true;
        }
      }

      // Rule requirement: only enforce when the `limit` parameter is declared.
      if (!hasLimit) continue;

      // If any declared limit parameter has a missing/wrong default, report.
      if (!hasInvalidDefault) continue;

      const { start, end } = findMethodParametersPositionInYaml(content, path, method);
      diagnostics.push({
        from: start,
        to: end,
        severity: mapSeverity(rule.severity),
        message: `Issue in path: "${path}", "${rule.message}"`,
        source: getSource(rule),
      });
    }
  }

  return diagnostics;
}
