import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import { BatchMatchConfig, isBatchOperation } from "@/utils/batchDetect";
import {
  schemaHasPropertyAnyOf,
  findFieldSchemaByNameDeep,
  schemaIsArrayLike, getResponseSchemaByStatus,
} from "@/utils/schema";
import { AsyncResponseConfig } from "@/types/async";
import { isAsyncOperation, operationHasStatusCode } from "@/utils/spec";

/**
 * ASY-010-01-2507-2507-M
 * Async batch response contract.
 *
 * For operations detected as batch (via `functionParams.batchMatch`) and async
 * (via `functionParams.asyncMatch.successStatusCode`, default "202"), validates that:
 * - the required async success status code exists, and
 * - the async response payload contains at least one configured job identifier field.
 *
 * Optionally, the rule can also require a resources list field in the async response.
 *
 * Behavior is controlled via `rule.call.functionParams`:
 * - batchMatch: batch detection configuration
 * - asyncMatch.successStatusCode: status code used to classify an operation as async
 * - require.statusCode: success status code that must be present
 * - require.jobIdAnyOf: acceptable job/task identifier field names
 * - require.resourcesListRequired: whether response must also contain a resource list
 * - require.resourcesListAnyOf: acceptable resource list field names
 */
export function checkAsyncBatchResponse(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths || typeof spec.paths !== "object") return diagnostics;

  const fp = rule?.call?.functionParams ?? {};

  const methodsToScan: string[] = Array.isArray(fp.methodsToScan)
    ? fp.methodsToScan.map((m: any) => String(m).toLowerCase())
    : []; // empty => scan all

  const cfg: BatchMatchConfig = (fp.batchMatch && typeof fp.batchMatch === "object") ? fp.batchMatch : {};
  const asyncCfg: AsyncResponseConfig = fp ?? {};

  const requiredStatusCode = String(asyncCfg.require?.statusCode ?? asyncCfg.asyncMatch?.successStatusCode ?? "202");
  const jobIdAnyOf = Array.isArray(asyncCfg.require?.jobIdAnyOf)
    ? asyncCfg.require!.jobIdAnyOf!.map((x) => String(x))
    : ["job_id", "jobId", "task_id", "taskId"];
  const resourcesListRequired = Boolean(asyncCfg.require?.resourcesListRequired);
  const resourcesListAnyOf = Array.isArray(asyncCfg.require?.resourcesListAnyOf)
    ? asyncCfg.require!.resourcesListAnyOf!.map((x) => String(x))
    : ["resources", "items", "results"];

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

      const isAsync = isAsyncOperation(operation, asyncCfg);
      if (!isAsync) continue;

      const hasRequiredStatus = operationHasStatusCode(operation, requiredStatusCode);
      let violation = "";

      if (!hasRequiredStatus) {
        violation = `Expected async success status code '${requiredStatusCode}'.`;
      } else {
        const responseSchema = getResponseSchemaByStatus(
          operation,
          requiredStatusCode,
          spec,
          refCache
        );

        if (!responseSchema) {
          violation = `Response for status '${requiredStatusCode}' is missing a schema.`;
        } else if (!schemaHasPropertyAnyOf(responseSchema, jobIdAnyOf, spec, refCache, new Set<any>())) {
          violation = `Expected one of job identifier fields in async response payload: ${jobIdAnyOf.join(", ")}.`;
        } else if (resourcesListRequired) {
          const listFieldSchema = findFieldSchemaByNameDeep(
            responseSchema,
            resourcesListAnyOf,
            spec,
            refCache,
            new Set<any>()
          );

          if (!listFieldSchema || !schemaIsArrayLike(listFieldSchema, spec, refCache)) {
            violation = `Expected one of [${resourcesListAnyOf.join(", ")}] as an array in async response payload.`;
          }
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
