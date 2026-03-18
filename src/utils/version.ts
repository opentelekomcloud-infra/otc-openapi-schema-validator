export type VersionConventionMode =
  | "presenceAndPrefix"
  | "formatCompliance"
  | "maxSegments"
  | "normalization";

/**
 * Removes optional single or double quotes around a version string.
 */
export function stripOuterQuotes(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Returns `info.version` as a normalized string value.
 */
export function getInfoVersion(spec: any): string {
  return stripOuterQuotes(String(spec?.info?.version ?? ""));
}

/**
 * Counts version segments after the `v` prefix.
 * Examples:
 * - v1 -> 1
 * - v1.2 -> 2
 * - v1.2.3 -> 3
 */
export function getVersionSegmentCount(version: string): number {
  const normalized = stripOuterQuotes(version);
  if (!normalized) return 0;
  if (!normalized.startsWith("v")) return 0;
  const body = normalized.slice(1);
  if (!body) return 0;
  return body.split(".").length;
}
