import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodParametersPositionInYaml } from "@/utils/pos";
import { collectQueryParams } from "@/utils/scan";

type SortingMode = {
  trigger: string;
  key: string;
  dir: string;
  allowedDirValues: string[];
  defaultDir?: string;
  requireTogether: boolean;
  enforceOrder: boolean;
  disallowOtherSortParams: boolean;
  checkEnums: boolean;
};

function normalizeMode(fp: any): SortingMode {
  const methods = Array.isArray(fp?.methods) ? fp.methods : undefined;
  void methods; // methods are handled in the main function

  // Support multiple legacy configs, but prefer the unified one.
  const key = String(fp?.keywords?.key ?? fp?.allowedKeywords?.[0] ?? "sort_key").toLowerCase();
  const dir = String(fp?.keywords?.dir ?? fp?.allowedKeywords?.[1] ?? "sort_dir").toLowerCase();

  const allowedDirValues: string[] = Array.isArray(fp?.allowedDirValues)
    ? fp.allowedDirValues.map((v: any) => String(v).toLowerCase())
    : Array.isArray(fp?.allowedValues)
      ? fp.allowedValues.map((v: any) => String(v).toLowerCase())
      : ["asc", "desc"];

  const defaultDir = fp?.defaultDir ?? fp?.defaultDirection;

  const requireTogether = fp?.requireTogether !== undefined ? Boolean(fp.requireTogether) : true;

  const enforceOrder = fp?.enforceOrder !== undefined
    ? Boolean(fp.enforceOrder)
    : fp?.checkSequence !== undefined
      ? Boolean(fp.checkSequence)
      : true;

  const disallowOtherSortParams = fp?.disallowOtherSortParams !== undefined
    ? Boolean(fp.disallowOtherSortParams)
    : fp?.disallowOtherParams !== undefined
      ? Boolean(fp.disallowOtherParams)
      : false;

  const checkEnums = fp?.checkEnums !== undefined ? Boolean(fp.checkEnums) : true;

  return {
    trigger: key, // if key exists, sorting is considered used
    key,
    dir,
    allowedDirValues,
    defaultDir: defaultDir != null ? String(defaultDir).toLowerCase() : undefined,
    requireTogether,
    enforceOrder,
    disallowOtherSortParams,
    checkEnums,
  };
}

/**
 * FIL-030-01-2507-2507-M
 * Sorting Parameters Consistency Check.
 *
 * Ensures sorting uses `sort_key` and `sort_dir` consistently:
 * - If either sorting parameter is used, the other must also be present (requireTogether).
 * - If both are present, they should appear in the order `sort_key`, then `sort_dir` (enforceOrder).
 * - `sort_dir` must allow only configured values (default: asc/desc) when enums are provided (checkEnums).
 * - `sort_dir` must specify a default direction (defaultDir) via `schema.default`.
 * - Optionally disallow other sorting-like parameters when sorting is used.
 */
export function checkSortingParams(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths) return diagnostics;

  const fp = rule?.call?.functionParams ?? {};
  const mode = normalizeMode(fp);

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

      const qParams = collectQueryParams(pathItem, operation, spec, refCache);
      if (qParams.length === 0) continue;

      const namesSet = new Set(qParams.map((p) => p.name));
      const hasKey = namesSet.has(mode.key);
      const hasDir = namesSet.has(mode.dir);

      // If sorting isn't used at all, do nothing.
      if (!hasKey && !hasDir) continue;

      const missing: string[] = [];
      const issues: string[] = [];

      // Must be together
      if (mode.requireTogether) {
        if (hasKey && !hasDir) missing.push(mode.dir);
        if (hasDir && !hasKey) missing.push(mode.key);
      }

      // Order check
      if (mode.enforceOrder && hasKey && hasDir) {
        const keyIdx = qParams.find((p) => p.name === mode.key)?.index ?? -1;
        const dirIdx = qParams.find((p) => p.name === mode.dir)?.index ?? -1;
        if (keyIdx >= 0 && dirIdx >= 0 && keyIdx > dirIdx) {
          issues.push(`Sorting parameter order must be '${mode.key}' then '${mode.dir}'.`);
        }
      }

      // Disallow other sorting-like params
      if (mode.disallowOtherSortParams) {
        const allowed = new Set([mode.key, mode.dir]);
        const otherSortLike = qParams
          .map((p) => p.name)
          .filter((n) => !allowed.has(n))
          .filter((n) => n.startsWith("sort") || n.includes("order"));
        if (otherSortLike.length > 0) {
          issues.push(`Sorting must use only '${mode.key}' and '${mode.dir}'. Found: ${Array.from(new Set(otherSortLike)).join(", ")}.`);
        }
      }

      // sort_dir allowed values and default
      if (hasDir) {
        const dirParam = qParams.find((p) => p.name === mode.dir)?.raw;
        const schema = (dirParam as any)?.schema;

        if (mode.checkEnums && schema && Array.isArray(schema.enum)) {
          const bad = (schema.enum as any[])
            .map((v) => String(v).toLowerCase())
            .filter((v) => !mode.allowedDirValues.includes(v));
          if (bad.length > 0) {
            issues.push(`'${mode.dir}' enum contains invalid value(s): ${Array.from(new Set(bad)).join(", ")}. Allowed: ${mode.allowedDirValues.join(", ")}.`);
          }
        }

        if (mode.defaultDir) {
          const def = schema?.default;
          if (def === undefined || String(def).toLowerCase() !== mode.defaultDir) {
            issues.push(`'${mode.dir}' must have default '${mode.defaultDir}'.`);
          }
        }
      }

      if (missing.length === 0 && issues.length === 0) continue;

      const { start, end } = findMethodParametersPositionInYaml(content, path, method);
      const details = [
        missing.length > 0 ? `Missing required query parameter(s): ${missing.join(", ")}.` : "",
        ...issues,
      ].filter(Boolean);

      diagnostics.push({
        from: start,
        to: end,
        severity: mapSeverity(rule.severity),
        message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message}. ${details.join(" ")}`,
        source: getSource(rule),
      });
    }
  }

  return diagnostics;
}
