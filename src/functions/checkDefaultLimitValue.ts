import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { queryParameters, queryParameterSchema } from "@/utils/nativeQuery";
import { ruleOperations } from "@/utils/nativeRule";

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

  for (const op of ruleOperations(spec, methodsToCheck.length ? { methods: methodsToCheck } : {})) {
    const { path, method } = op;
    let hasLimit = false;
    let hasInvalidDefault = false;
    for (const parameter of queryParameters(op, spec, refCache, true)) {
      if (parameter.name !== "limit") continue;
      hasLimit = true;
      const actualDefault = queryParameterSchema(parameter, spec, refCache)?.node.default;
      if (actualDefault === undefined || String(actualDefault) !== String(defaultValue)) {
        hasInvalidDefault = true;
      }
    }
    if (!hasLimit || !hasInvalidDefault) continue;
    const { start, end } = findMethodParametersPositionInYaml(content, path, method);
    diagnostics.push({
      from: start,
      to: end,
      severity: mapSeverity(rule.severity),
      message: `Issue in path: "${path}", "${rule.message}"`,
      source: getSource(rule),
    });
  }

  return diagnostics;
}
