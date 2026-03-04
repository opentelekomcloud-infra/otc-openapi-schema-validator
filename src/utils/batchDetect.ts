import { pathHasQueryFlag, textContainsAny } from "@/utils/textMatch";
import { getRequestBodySchema, schemaHasAnyArrayOfObjectsDeep, schemaIsArrayOfObjects } from "@/utils/schema";
import { isActionTagsBatchPayload } from "@/utils/batchPatterns";

export type BatchMatchConfig = {
  /** Case-insensitive keywords searched in summary/description/operationId. */
  keywords?: string[];
  /** Substrings that, if present in the path string, indicate a batch-style endpoint. */
  pathContainsAny?: string[];
  /** Query flags like `delete` matched as `?delete` or `&delete` in the path string. */
  queryFlagsAny?: string[];
  /**
   * If provided, the operation is considered "batch" only if AT LEAST ONE of the listed
   * detection signals is true.
   * Supported values: "keywordMatch", "payloadLooksBatch", "actionPayloadPattern".
   */
  requireOneOf?: string[];
};

/**
 * Determines whether an operation is a batch operation.
 *
 * We intentionally keep this detector conservative to avoid false positives:
 * - Keyword match (summary/description/operationId) OR
 * - Path contains configured substrings OR
 * - Query flag match OR
 * - For paths containing `/action`, require the request payload to look batch-like
 *   (array<object>, wrapper with array<object>, or action+tags batch).
 */
export function isBatchOperation(
  path: string,
  operation: any,
  spec: any,
  refCache: Map<string, any>,
  cfg: BatchMatchConfig
): boolean {
  const keywords = Array.isArray(cfg.keywords) ? cfg.keywords : [];
  const pathContainsAny = Array.isArray(cfg.pathContainsAny) ? cfg.pathContainsAny : [];
  const queryFlagsAny = Array.isArray(cfg.queryFlagsAny) ? cfg.queryFlagsAny : [];
  const requireOneOf = Array.isArray(cfg.requireOneOf) ? cfg.requireOneOf.map((s) => String(s)) : [];

  const summary = String(operation?.summary ?? "");
  const description = String(operation?.description ?? "");
  const operationId = String(operation?.operationId ?? "");
  const text = `${summary} ${description} ${operationId}`;

  const keywordMatch = keywords.length > 0 && textContainsAny(text, keywords);
  const pathSubMatch = pathContainsAny.length > 0 && textContainsAny(path, pathContainsAny);
  const queryFlagMatch = queryFlagsAny.length > 0 && queryFlagsAny.some((f) => pathHasQueryFlag(path, String(f)));

  // Basic gating: if none of the configured high-level indicators matched, do not treat as batch.
  // (This avoids classifying arbitrary endpoints as batch based on payload shape alone.)
  if (!keywordMatch && !pathSubMatch && !queryFlagMatch) return false;

  // Some batch signals require inspecting the payload. Only do this work when requested or
  // when the path suggests an action-style endpoint.
  const needsPayload =
    requireOneOf.includes("payloadLooksBatch") ||
    requireOneOf.includes("actionPayloadPattern") ||
    path.toLowerCase().includes("/action");

  let payloadLooksBatch = false;
  let actionPayloadPattern = false;

  if (needsPayload) {
    const rbSchema = getRequestBodySchema(operation, spec, refCache);
    if (rbSchema) {
      payloadLooksBatch =
        schemaIsArrayOfObjects(rbSchema, spec, refCache) ||
        schemaHasAnyArrayOfObjectsDeep(rbSchema, spec, refCache);

      actionPayloadPattern = isActionTagsBatchPayload(rbSchema, spec, refCache);
    }
  }

  // If requireOneOf is configured, enforce it.
  if (requireOneOf.length > 0) {
    const ok = requireOneOf.some((signal) => {
      const s = String(signal);
      if (s === "keywordMatch") return keywordMatch;
      if (s === "payloadLooksBatch") return payloadLooksBatch;
      if (s === "actionPayloadPattern") return actionPayloadPattern;
      return false;
    });

    if (!ok) return false;
  } else {
    // Backward-compatible behavior: accept as batch if any strong indicator matches,
    // otherwise, for `/action` endpoints require a batch-looking payload.
    if (keywordMatch || pathSubMatch || queryFlagMatch) return true;

    if (path.toLowerCase().includes("/action")) {
      return payloadLooksBatch || actionPayloadPattern;
    }

    return false;
  }

  return true;
}
