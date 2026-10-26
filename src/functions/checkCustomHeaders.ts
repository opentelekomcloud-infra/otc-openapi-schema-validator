import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { collectHeaderLocations } from "@/utils/scan";
import { isCustomHeader } from "@/utils/headers";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { ruleDocument, ruleStrings, type NativeRule } from "@/utils/nativeRule";

/**
 * HDR-020-01-2507-2507-M-3
 * Custom Header Naming and Format Validation.
 *
 * This rule verifies that all non-standard (custom) HTTP headers declared
 * in request parameters (`in: header`) and in response `headers` sections
 * follow the required naming convention.
 *
 * A header is considered for validation if it is not part of the known
 * standard HTTP header list (including rule-provided `standard_headers`).
 *
 * Behavior is controlled via `rule.call.functionParams`:
 * - header_format: string
 *   Regular expression that defines the allowed naming convention
 *   (e.g. must start with `X-` or `x-`, hyphen-separated words, etc.).
 * - standard_headers: string[]
 *   Additional header names to treat as standard (excluded from validation).
 *
 * The rule traverses:
 * - Path-level and operation-level parameters with `in: header`
 * - Response header names under `responses[*].headers`
 */
export function checkCustomHeaders(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  ruleDocument(spec);

  const params = rule?.call?.functionParams ?? {};
  const headerFormatPattern = params.header_format;
  if (typeof headerFormatPattern !== "string" || !headerFormatPattern) {
    throw new Error("functionParams.header_format must be a non-empty regular expression.");
  }
  const headerRegex = new RegExp(headerFormatPattern);

  const standardHeaders = new Set<string>(DEFAULT_STANDARD_HEADERS);
  ruleStrings(params.standard_headers, "standard_headers").forEach((name) => standardHeaders.add(name.toLowerCase()));

  const headers = collectHeaderLocations(spec);

  for (const h of headers) {
    if (!isCustomHeader(h.headerName, standardHeaders)) continue;

    if (!headerRegex.test(h.headerName)) {
      const isResponseHeader = h.direction === "response";
      const src = sourceMap(content).locate(h.sourcePointer, isResponseHeader ? "key" : "value", true);

      diagnostics.push({
        from: src.from,
        to: src.to,
        severity: mapSeverity(rule?.severity),
        source: getSource(rule),
        message:
          `${rule?.message ?? "Invalid custom header format."} ` +
          `Header "${h.headerName}" at ${h.jsonPointer} does not match ${headerFormatPattern}.`,
      });
    }
  }

  return diagnostics;
}

const DEFAULT_STANDARD_HEADERS = new Set(
  [
    "accept",
    "authorization",
  ].map((h) => h.toLowerCase())
);
