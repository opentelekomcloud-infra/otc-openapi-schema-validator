import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import { BatchMatchConfig, isBatchOperation } from "@/utils/batchDetect";

/**
 * STS-030-01-2507-2507-M-1
 * Batch operations must use POST.
 *
 * If an operation is detected as a batch operation (via `functionParams.batchMatch`),
 * its HTTP method must be one of `functionParams.allowedMethods` (default: ["post"]).
 *
 * Behavior is controlled via rule.call.functionParams:
 * - methodsToScan: string[]
 *   HTTP methods to scan under each path (default: all methods in the spec).
 * - batchMatch: { keywords?, pathContainsAny?, queryFlagsAny?, requireOneOf? }
 *   Batch detection configuration.
 * - allowedMethods: string[]
 *   Allowed HTTP methods for batch operations (default: ["post"]).
 */
export function checkBatchUsesPost(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths || typeof spec.paths !== "object") return diagnostics;

  const fp = rule?.call?.functionParams ?? {};

  const methodsToScan: string[] = Array.isArray(fp.methodsToScan)
    ? fp.methodsToScan.map((m: any) => String(m).toLowerCase())
    : []; // empty => scan all

  const allowedMethods: string[] = Array.isArray(fp.allowedMethods)
    ? fp.allowedMethods.map((m: any) => String(m).toLowerCase())
    : ["post"];

  const cfg: BatchMatchConfig = (fp.batchMatch && typeof fp.batchMatch === "object") ? fp.batchMatch : {};

  for (const path of Object.keys(spec.paths)) {
    const pathItem = (spec.paths as any)[path];
    if (!pathItem || typeof pathItem !== "object") continue;

    const availableMethods = Object.keys(pathItem)
      .map((k) => String(k).toLowerCase())
      .filter((k) => !["parameters", "$ref", "summary", "description"].includes(k));

    const methodKeys = methodsToScan.length > 0 ? methodsToScan : availableMethods;

    for (const method of methodKeys) {
      const operation = (pathItem as any)[method];
      if (!operation || typeof operation !== "object") continue;

      const isBatch = isBatchOperation(path, operation, spec, refCache, cfg);
      if (!isBatch) continue;

      if (allowedMethods.includes(method)) continue;

      const { start, end } = findMethodPositionInYaml(content, path, method);
      diagnostics.push({
        from: start,
        to: end,
        severity: mapSeverity(rule.severity),
        message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message} Allowed methods: ${allowedMethods
          .map((m) => m.toUpperCase())
          .join(", ")}.`,
        source: getSource(rule),
      });
    }
  }

  return diagnostics;
}
