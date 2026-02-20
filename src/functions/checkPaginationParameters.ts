import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { resolveRefDeep } from "@/utils/schema";

export function checkPaginationParameters(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths) return diagnostics;

  const params = rule?.call?.functionParams ?? {};

  const methodsToCheck: string[] = Array.isArray(params.methods)
    ? params.methods.map((m: any) => String(m).toLowerCase())
    : [];

  const modesRaw: any[] = Array.isArray(params.modes) ? params.modes : [];
  const modes = modesRaw
    .map((m) => {
      const trigger = String(m?.trigger ?? "").toLowerCase();
      const require = Array.isArray(m?.require) ? m.require.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
      const forbid = Array.isArray(m?.forbid) ? m.forbid.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
      return { trigger, require, forbid };
    })
    .filter((m) => m.trigger);

  if (modes.length === 0) return diagnostics;

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

      const present = new Set<string>();

      for (const p of allParams) {
        const param = resolveRefDeep(p, refCache, spec);
        if (!param || typeof param !== "object") continue;

        const inVal = String((param as any).in ?? "").toLowerCase();
        if (inVal !== "query") continue;

        const name = String((param as any).name ?? "").toLowerCase();
        if (!name) continue;

        present.add(name);
      }

      const triggered = modes.filter((m) => present.has(m.trigger));
      if (triggered.length === 0) continue;

      const { start, end } = findMethodParametersPositionInYaml(content, path, method);

      // If both pagination styles are used together, report a conflict.
      if (triggered.length > 1) {
        diagnostics.push({
          from: start,
          to: end,
          severity: mapSeverity(rule.severity),
          message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message}. Conflicting pagination triggers present: ${triggered
            .map((t) => t.trigger)
            .join(", ")}.`,
          source: getSource(rule),
        });
        continue;
      }

      const mode = triggered[0];
      const missing = mode.require.filter((r: string) => !present.has(r));
      if (missing.length > 0) {
        diagnostics.push({
          from: start,
          to: end,
          severity: mapSeverity(rule.severity),
          message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message}. Missing required query parameter(s) for '${mode.trigger}': ${missing.join(", ")}.`,
          source: getSource(rule),
        });
        continue;
      }

      const forbidden = mode.forbid.filter((f: string) => present.has(f));
      if (forbidden.length > 0) {
        diagnostics.push({
          from: start,
          to: end,
          severity: mapSeverity(rule.severity),
          message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message}. Not allowed together with '${mode.trigger}': ${forbidden.join(", ")}.`,
          source: getSource(rule),
        });
      }
    }
  }

  return diagnostics;
}
