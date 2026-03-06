import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findRequestBodyPositionInYaml} from "@/utils/pos";
import { BatchMatchConfig, isBatchOperation } from "@/utils/batchDetect";
import {
  getRequestBodySchema,
  schemaHasAnyArrayOfObjectsDeep,
  schemaIsArrayOfObjects
} from "@/utils/schema";
import {isActionTagsBatchPayload} from "@/utils/batchPatterns";
import { PayloadConfig } from "@/types/batch";

/**
 * STS-030-01-2507-2507-M-2
 * Batch request payload must be array of objects.
 *
 * For operations detected as batch (via `functionParams.batchMatch`), verifies that
 * the request body schema represents a list of resources either:
 * - directly as `array<object>`, or
 * - inside an object wrapper that contains any `array<object>` somewhere within it, or
 * - using the common `action=create|delete` + `tags: array<object>` pattern.
 *
 * Media type selection is controlled via `functionParams.payload.contentTypesPreferred`.
 */
export function checkBatchPayloadArrayOfObjects(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths || typeof spec.paths !== "object") return diagnostics;

  const fp = rule?.call?.functionParams ?? {};
  const payloadCfg: PayloadConfig = (fp.payload && typeof fp.payload === "object") ? fp.payload : {};

  const methodsToScan: string[] = Array.isArray(fp.methodsToScan)
    ? fp.methodsToScan.map((m: any) => String(m).toLowerCase())
    : [];

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

      const schema = getRequestBodySchema(operation, spec, refCache, payloadCfg);

      const allowTopLevelArray = payloadCfg.allowTopLevelArray !== false;
      const allowWrapper = payloadCfg.allowObjectWrapperWithAnyArrayOfObjects !== false;
      const allowActionTags = payloadCfg.allowActionEnumCreateDeleteWithTagsArray !== false;

      const ok =
        (allowTopLevelArray && schemaIsArrayOfObjects(schema, spec, refCache)) ||
        (allowWrapper && schemaHasAnyArrayOfObjectsDeep(schema, spec, refCache)) ||
        (allowActionTags && isActionTagsBatchPayload(schema, spec, refCache));

      if (ok) continue;

      const { start, end } = findRequestBodyPositionInYaml(content, path, method);

      const preferred = Array.isArray(payloadCfg.contentTypesPreferred) && payloadCfg.contentTypesPreferred.length > 0
        ? payloadCfg.contentTypesPreferred
        : ["application/json", "application/problem+json", "application/xml"];

      const extra = schema
        ? `Request body schema must be array<object> or a wrapper containing array<object>. Checked media types: ${preferred.join(", ")}.`
        : `Request body is missing or has no schema. Checked media types: ${preferred.join(", ")}.`;

      diagnostics.push({
        from: start,
        to: end,
        severity: mapSeverity(rule.severity),
        message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message} ${extra}`,
        source: getSource(rule),
      });
    }
  }

  return diagnostics;
}
