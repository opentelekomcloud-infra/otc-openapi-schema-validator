import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { getSource } from "@/functions/common";
import { findInfoVersionPosition } from "@/utils/spec";
import { stripOuterQuotes } from "@/utils/version";
import { resolveRefDeep } from "@/utils/schema";

const remoteSpecCache: Record<string, any> = {};

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
 * Creates a stable lookup key for an operation.
 */
function operationKey(path: string, method: string): string {
  return `${method.toLowerCase()} ${path}`;
}

/**
 * Returns all HTTP operations from the spec keyed by `METHOD path`.
 */
function collectOperations(spec: any): Record<string, any> {
  const result: Record<string, any> = {};
  const paths = spec?.paths;
  if (!paths || typeof paths !== "object") return result;

  for (const path of Object.keys(paths)) {
    const pathItem = (paths as any)[path];
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of Object.keys(pathItem)) {
      const lowered = String(method).toLowerCase();
      if (["get", "post", "put", "patch", "delete", "options", "head"].includes(lowered)) {
        result[operationKey(path, lowered)] = (pathItem as any)[method];
      }
    }
  }

  return result;
}

/**
 * Resolves a parameter object if it is declared through a local `$ref`.
 *
 * This is required for breaking-change checks because many specs keep reusable
 * parameters under `#/components/parameters/...` and reference them from paths
 * and operations.
 */
function resolveParameterRef(param: any, spec: any): any {
  if (!param || typeof param !== "object") return null;
  return resolveRefDeep(param, new Map<string, any>(), spec);
}

/**
 * Collects parameter signatures for an operation, including path-level parameters.
 *
 * Local `$ref` parameters from `#/components/parameters/...` are resolved before
 * comparison so that removed referenced parameters are detected correctly.
 */
function collectParameterMap(spec: any, path: string, method: string): Record<string, { required: boolean; schemaType: string }> {
  const result: Record<string, { required: boolean; schemaType: string }> = {};
  const pathItem = spec?.paths?.[path];
  const operation = pathItem?.[method];
  if (!pathItem || !operation) return result;

  const allParams = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];

  for (const rawParam of allParams) {
    const param = resolveParameterRef(rawParam, spec);
    if (!param || typeof param !== "object") continue;

    const name = String((param as any).name ?? "");
    const paramIn = String((param as any).in ?? "").toLowerCase();
    if (!name || !paramIn) continue;

    const key = `${paramIn}:${name}`;
    const schemaType = String((param as any).schema?.type ?? "");
    result[key] = {
      required: Boolean((param as any).required),
      schemaType,
    };
  }

  return result;
}

/**
 * Returns shallow response-code map for an operation.
 */
function collectResponseCodes(operation: any): Record<string, any> {
  const out: Record<string, any> = {};
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return out;

  for (const code of Object.keys(responses)) {
    out[String(code)] = (responses as any)[code];
  }

  return out;
}

/**
 * Extracts a coarse response body media-type set for a response object.
 */
function collectResponseMediaTypes(response: any): Set<string> {
  const out = new Set<string>();
  if (!response || typeof response !== "object") return out;
  const content = (response as any).content;
  if (!content || typeof content !== "object") return out;
  for (const mediaType of Object.keys(content)) {
    out.add(String(mediaType));
  }
  return out;
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
function detectBreakingChanges(baseSpec: any, currentSpec: any): BreakingChange[] {
  const changes: BreakingChange[] = [];

  const baseOps = collectOperations(baseSpec);
  const currentOps = collectOperations(currentSpec);

  for (const key of Object.keys(baseOps)) {
    if (!currentOps[key]) {
      const [method, ...pathParts] = key.split(" ");
      const path = pathParts.join(" ");
      changes.push({
        kind: "operationRemoved",
        path,
        method,
        details: `Operation '${key}' was removed.`,
      });
      continue;
    }

    const [method, ...pathParts] = key.split(" ");
    const path = pathParts.join(" ");

    const baseParams = collectParameterMap(baseSpec, path, method);
    const currentParams = collectParameterMap(currentSpec, path, method);

    for (const paramKey of Object.keys(baseParams)) {
      const before = baseParams[paramKey];
      const after = currentParams[paramKey];

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

    const baseResponses = collectResponseCodes(baseOps[key]);
    const currentResponses = collectResponseCodes(currentOps[key]);

    for (const code of Object.keys(baseResponses)) {
      if (!/^2\d\d$/.test(code)) continue;

      const beforeResponse = baseResponses[code];
      const afterResponse = currentResponses[code];

      if (!afterResponse) {
        changes.push({
          kind: "responseRemoved",
          path,
          method,
          details: `Success response '${code}' was removed from '${key}'.`,
        });
        continue;
      }

      const beforeMedia = collectResponseMediaTypes(beforeResponse);
      const afterMedia = collectResponseMediaTypes(afterResponse);

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
export async function checkIncompatibleChangeVersioning(spec: any, content: string, rule: any): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  const repo = await fetchRepoMap(spec);
  if (!repo) return diagnostics;

  const cacheKey = `${repo.reponame}:${repo.filename || repo.reponame}`;
  let remoteSpec = remoteSpecCache[cacheKey];
  if (!remoteSpec) {
    remoteSpec = await fetchSpecFromGitea(repo);
    if (!remoteSpec) return diagnostics;
    remoteSpecCache[cacheKey] = remoteSpec;
  }

  const changes = detectBreakingChanges(remoteSpec, spec);
  if (changes.length === 0) return diagnostics;

  const currentVersion = String(spec?.info?.version ?? "");
  const baseVersion = String(remoteSpec?.info?.version ?? "");

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
