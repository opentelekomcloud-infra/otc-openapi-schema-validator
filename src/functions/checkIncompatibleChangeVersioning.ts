import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { nativeBaseline, readBaseline } from "@/lib/openapi/baseline";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import type { NativeOpenApiDocument } from "@/types/openapi";
import { getSource } from "@/functions/common";
import { findInfoVersionPosition } from "@/utils/spec";
import { stripOuterQuotes } from "@/utils/version";
import { comparisonOperations, comparisonParameters, responseCodes, responseMediaTypes } from "@/utils/nativeCompatibility";
import { isRecord } from "@/lib/openapi/references";

type BreakingChange = {
  kind: string;
  path?: string;
  method?: string;
  details: string;
};

/**
 * Extracts the major version from strings like `v1`, `v2.3`, `v4.5.6`.
 * Returns null when the version cannot be parsed.
 */
function extractMajorVersion(version: string): number | null {
  const normalized = stripOuterQuotes(version);
  const match = normalized.match(/^v(\d+)(?:\.\d+){0,2}$/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Groups breaking changes by operation (`METHOD path`).
 *
 * Diagnostics for this rule are intentionally anchored to `info.version`, but
 * grouping by operation keeps the report readable and avoids one oversized message.
 */
function groupBreakingChangesByOperation(changes: BreakingChange[]): Record<string, BreakingChange[]> {
  const grouped: Record<string, BreakingChange[]> = {};

  for (const change of changes) {
    const method = String(change.method ?? "unknown").toUpperCase();
    const path = String(change.path ?? "unknown-path");
    const key = `${method} ${path}`;

    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(change);
  }

  return grouped;
}

/**
 * Detects breaking changes between the baseline spec and the current spec.
 *
 * This is intentionally conservative and focuses on changes that are usually
 * backward-incompatible:
 * - removed operations
 * - removed parameters
 * - optional parameter becoming required
 * - removed success response codes
 * - removed response media types for an existing response code
 */
function detectBreakingChanges(baseSpec: NativeOpenApiDocument, currentSpec: NativeOpenApiDocument): BreakingChange[] {
  const changes: BreakingChange[] = [];

  const methods = ["get", "post", "put", "patch", "delete", "options", "head"];
  const baseOps = readBaseline(() => comparisonOperations(baseSpec, methods));
  const currentOps = comparisonOperations(currentSpec, methods, new Set([...baseOps.values()].map((operation) => operation.path)));
  const baseCache = new Map<string, unknown>();
  const currentCache = new Map<string, unknown>();

  for (const [key, baseOperation] of baseOps) {
    const { method, path } = baseOperation;
    const currentOperation = currentOps.get(key);
    if (!currentOperation) {
      changes.push({
        kind: "operationRemoved",
        path,
        method,
        details: `Operation '${key}' was removed.`,
      });
      continue;
    }

    const baseParams = readBaseline(() => comparisonParameters(baseSpec, baseOperation, baseCache));
    const currentParams = comparisonParameters(currentSpec, currentOperation, currentCache);

    for (const [paramKey, before] of baseParams) {
      const after = currentParams.get(paramKey);

      if (!after) {
        changes.push({
          kind: "parameterRemoved",
          path,
          method,
          details: `Parameter '${paramKey}' was removed from '${key}'.`,
        });
        continue;
      }

      if (!before.required && after.required) {
        changes.push({
          kind: "parameterBecameRequired",
          path,
          method,
          details: `Parameter '${paramKey}' became required in '${key}'.`,
        });
      }
    }

    const currentResponses = new Set(responseCodes(currentOperation));

    for (const code of readBaseline(() => responseCodes(baseOperation))) {
      if (!/^2\d\d$/.test(code)) continue;

      if (!currentResponses.has(code)) {
        changes.push({
          kind: "responseRemoved",
          path,
          method,
          details: `Success response '${code}' was removed from '${key}'.`,
        });
        continue;
      }

      const beforeMedia = readBaseline(() => responseMediaTypes(baseSpec, baseOperation, code, baseCache));
      const afterMedia = responseMediaTypes(currentSpec, currentOperation, code, currentCache);
      if (!beforeMedia || !afterMedia) continue;

      for (const mediaType of beforeMedia) {
        if (!afterMedia.has(mediaType)) {
          changes.push({
            kind: "responseMediaTypeRemoved",
            path,
            method,
            details: `Response media type '${mediaType}' for status '${code}' was removed from '${key}'.`,
          });
        }
      }
    }
  }

  return changes;
}

/**
 * VER-030-01-2507-2507-O-5
 * Incompatible Changes Versioning.
 *
 * Compares the current spec with the baseline spec fetched from the repository.
 * If backward-incompatible changes are detected, the current major version must be
 * greater than the baseline major version.
 */
export async function checkIncompatibleChangeVersioning(spec: unknown, content: string, rule: any): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  const current = classifyNativeOpenApiDocument(spec);
  const remoteSpec = await nativeBaseline(spec);

  const changes = detectBreakingChanges(remoteSpec, current);
  if (changes.length === 0) return diagnostics;

  const currentVersion = String(isRecord(current.document.info) ? current.document.info.version ?? "" : "");
  const baseVersion = String(isRecord(remoteSpec.document.info) ? remoteSpec.document.info.version ?? "" : "");

  const currentMajor = extractMajorVersion(currentVersion);
  const baseMajor = extractMajorVersion(baseVersion);

  if (currentMajor == null || baseMajor == null) {
    const { start, end } = findInfoVersionPosition(content);
    diagnostics.push({
      from: start,
      to: end,
      severity: mapSeverity(rule.severity),
      message: `${rule.message} Could not compare major versions reliably (current='${stripOuterQuotes(currentVersion)}', baseline='${stripOuterQuotes(baseVersion)}') while incompatible changes were detected: ${changes[0].details}`,
      source: getSource(rule),
    });
    return diagnostics;
  }

  if (currentMajor > baseMajor) return diagnostics;

  const grouped = groupBreakingChangesByOperation(changes);
  const { start, end } = findInfoVersionPosition(content);

  for (const operationKey of Object.keys(grouped)) {
    const operationChanges = grouped[operationKey];
    const preview = operationChanges.slice(0, 3).map((c) => c.details).join(" ");
    const extraCount = operationChanges.length > 3 ? ` (+${operationChanges.length - 3} more)` : "";

    diagnostics.push({
      from: start,
      to: end,
      severity: mapSeverity(rule.severity),
      message: `${rule.message} Incompatible changes were detected for ${operationKey}, but major version was not increased (baseline='${stripOuterQuotes(baseVersion)}', current='${stripOuterQuotes(currentVersion)}'). ${preview}${extraCount}`,
      source: getSource(rule),
    });
  }

  return diagnostics;
}
