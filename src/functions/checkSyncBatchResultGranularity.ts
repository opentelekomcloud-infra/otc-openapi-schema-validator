import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import { BatchMatchConfig, isBatchOperation } from "@/utils/batchDetect";
import {
  arrayItemsHaveStatusField,
  findFieldSchemaByNameDeep,
  getResponseSchema,
  schemaHasContentForConfiguredTypes,
  schemaHasPropertyAnyOf,
  schemaIsArrayLike,
} from "@/utils/schema";
import { SyncGranularityConfig } from "@/types/batch";

/**
 * STS-030-01-2507-2507-M-3
 * Sync batch result granularity.
 *
 * For operations detected as batch (via `functionParams.batchMatch`), validates the
 * successful response payload according to the configured synchronous result granularity:
 * - `perItem`: response must contain a list field and each item must expose a status-like field.
 * - `allOrNothing`: response may expose all-or-nothing markers, and item-level status must be omitted.
 * - `auto`: infer intent from the response schema; if all-or-nothing markers are present,
 *   item-level status must be omitted; if per-item list fields are present, item-level status must be present.
 *
 * By default, this rule only inspects JSON-like response content types configured in
 * `functionParams.contentTypes` and only runs when those content types are present if
 * `onlyIfResponseHasContent` is true.
 */
export function checkSyncBatchResultGranularity(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths || typeof spec.paths !== "object") return diagnostics;

  const fp = rule?.call?.functionParams ?? {};
  const cfg: BatchMatchConfig = (fp.batchMatch && typeof fp.batchMatch === "object") ? fp.batchMatch : {};
  const syncCfg: SyncGranularityConfig = fp ?? {};

  const methodsToScan: string[] = Array.isArray(fp.methodsToScan)
    ? fp.methodsToScan.map((m: any) => String(m).toLowerCase())
    : []; // empty => scan all

  const mode = String(syncCfg.mode ?? "auto");
  const listFields = Array.isArray(syncCfg.perItem?.listFieldsAnyOf)
    ? syncCfg.perItem!.listFieldsAnyOf!.map((x) => String(x))
    : ["resources", "items", "results", "statuses"];
  const statusFields = Array.isArray(syncCfg.perItem?.statusFieldsAnyOf)
    ? syncCfg.perItem!.statusFieldsAnyOf!.map((x) => String(x))
    : ["status", "result", "state", "error_code", "errorCode", "error_message", "errorMessage"];
  const allOrNothingMarkers = Array.isArray(syncCfg.allOrNothing?.markersAnyOf)
    ? syncCfg.allOrNothing!.markersAnyOf!.map((x) => String(x))
    : ["all_resources_success", "all_resources_failure", "all_success", "all_failure"];

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

      if (syncCfg.onlyIfResponseHasContent && !schemaHasContentForConfiguredTypes(operation, syncCfg)) {
        continue;
      }

      const responseSchema = getResponseSchema(operation, spec, refCache, syncCfg);
      if (!responseSchema) continue;

      const hasAllOrNothingMarker = schemaHasPropertyAnyOf(
        responseSchema,
        allOrNothingMarkers,
        spec,
        refCache,
        new Set<any>()
      );

      const listFieldSchema = findFieldSchemaByNameDeep(
        responseSchema,
        listFields,
        spec,
        refCache,
        new Set<any>()
      );
      const hasPerItemList = Boolean(listFieldSchema && schemaIsArrayLike(listFieldSchema, spec, refCache));
      const hasPerItemStatus = Boolean(listFieldSchema && arrayItemsHaveStatusField(listFieldSchema, statusFields, spec, refCache));

      let violation = "";

      if (mode === "perItem") {
        if (!hasPerItemList) {
          violation = `Expected one of [${listFields.join(", ")}] as an array in the response payload.`;
        } else if (!hasPerItemStatus) {
          violation = `Expected item-level status field in response list items. Allowed status fields: ${statusFields.join(", ")}.`;
        }
      } else if (mode === "allOrNothing") {
        if (hasPerItemStatus) {
          violation = `Item-level status must be omitted for all-or-nothing synchronous batch responses.`;
        }
      } else {
        // auto
        if (hasAllOrNothingMarker && hasPerItemStatus) {
          violation = `All-or-nothing markers are present, so item-level status must be omitted.`;
        } else if (!hasAllOrNothingMarker && hasPerItemList && !hasPerItemStatus) {
          violation = `Per-item response list is present, so each item must expose a status field.`;
        }
      }

      if (!violation) continue;

      const { start, end } = findMethodPositionInYaml(content, path, method);
      diagnostics.push({
        from: start,
        to: end,
        severity: mapSeverity(rule.severity),
        message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message} ${violation}`,
        source: getSource(rule),
      });
    }
  }

  return diagnostics;
}
