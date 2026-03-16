import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { mapSeverity } from "@/utils/mapSeverity";
import { findInfoVersionPosition } from "@/utils/spec";
import { getInfoVersion, getVersionSegmentCount, VersionConventionMode } from "@/utils/version";

/**
 * VER-030 shared function.
 *
 * Supports multiple version-convention rules through `functionParams.mode`:
 * - presenceAndPrefix
 * - formatCompliance
 * - maxSegments
 * - normalization
 */
export function checkVersionConvention(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const fp = rule?.call?.functionParams ?? {};
  const mode = String(fp.mode ?? "formatCompliance") as VersionConventionMode;
  const version = getInfoVersion(spec);

  let details = "";

  if (mode === "presenceAndPrefix") {
    const pattern = String(fp.versionPattern ?? "^v.+$");
    const re = new RegExp(pattern);

    if (!version) {
      details = `Missing info.version.`;
    } else if (!re.test(version)) {
      details = `Version \"${version}\" must start with 'v'.`;
    }
  } else if (mode === "formatCompliance") {
    const pattern = String(fp.versionPattern ?? "^v[0-9]+(\\.[0-9]+)?(\\.[0-9]+)?$");
    const re = new RegExp(pattern);

    if (!version) {
      details = `Missing info.version.`;
    } else if (!re.test(version)) {
      details = `Version \"${version}\" does not match required format ${pattern}.`;
    }
  } else if (mode === "maxSegments") {
    const maxVersions = Number(fp.maxVersions ?? 4);
    const segmentCount = getVersionSegmentCount(version);

    if (!version) {
      details = `Missing info.version.`;
    } else if (segmentCount === 0) {
      details = `Version \"${version}\" is not a valid version string.`;
    } else if (segmentCount > maxVersions) {
      details = `Version \"${version}\" contains ${segmentCount} segments, which exceeds the allowed maximum of ${maxVersions}.`;
    }
  } else if (mode === "normalization") {
    const pattern = String(fp.deprecatedPattern ?? "^v[0-9]+(\\.[0-9]+){1,2}$");
    const re = new RegExp(pattern);

    if (!version) {
      details = `Missing info.version.`;
    } else if (re.test(version)) {
      details = `Version \"${version}\" is non-normalized; prefer major-only format like vX.`;
    }
  }

  if (!details) return diagnostics;

  const { start, end } = findInfoVersionPosition(content);
  diagnostics.push({
    from: start,
    to: end,
    severity: mapSeverity(rule.severity),
    message: `${rule.message} ${details}`,
    source: getSource(rule),
  });

  return diagnostics;
}
