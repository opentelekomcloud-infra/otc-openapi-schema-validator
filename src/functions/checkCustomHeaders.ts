import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { safeRegex } from "@/utils/regex";
import { collectHeaderLocations } from "@/utils/scan";
import { isCustomHeader } from "@/utils/headers";

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
export function checkCustomHeaders(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!spec?.paths) return diagnostics;

  const params = rule?.call?.functionParams ?? {};
  const headerFormatPattern: string | undefined = params.header_format;
  const headerRegex = safeRegex(headerFormatPattern);

  const standardHeaders = new Set<string>(DEFAULT_STANDARD_HEADERS);
  if (Array.isArray(params.standard_headers)) {
    params.standard_headers
      .filter((h: any) => typeof h === "string")
      .forEach((h: string) => standardHeaders.add(h.toLowerCase()));
  }

  const headers = collectHeaderLocations(spec);

  let paramCursor = 0;
  let responseCursor = 0;

  for (const h of headers) {
    if (!isCustomHeader(h.headerName, standardHeaders)) continue;

    // If regex is not valid/missing, do nothing (avoid false positives / crashes)
    if (!headerRegex) continue;

    if (!headerRegex.test(h.headerName)) {
      // Plain sequential scan to get stable positions per occurrence.
      // We rely on traversal order and keep separate cursors for parameters vs responses.
      const isResponseHeader = h.jsonPointer.includes(".responses.") && h.jsonPointer.includes(".headers.");

      let src: { from: number; to: number } = { from: 0, to: 0 };

      if (isResponseHeader) {
        const needleKey = `${h.headerName}:`;
        const needleQuotedKey = `"${h.headerName}":`;

        let idx = content.indexOf(needleKey, responseCursor);
        let len = needleKey.length;

        // Prefer unquoted key; if not found, try quoted key.
        if (idx === -1) {
          idx = content.indexOf(needleQuotedKey, responseCursor);
          len = needleQuotedKey.length;
        }

        if (idx !== -1) {
          src = { from: idx, to: idx + len };
          responseCursor = idx + len;
        }
      } else {
        // Parameters: header name is stored as `name: <header>` in YAML.
        const needleName = `name: ${h.headerName}`;
        const idx = content.indexOf(needleName, paramCursor);
        if (idx !== -1) {
          src = { from: idx, to: idx + needleName.length };
          paramCursor = idx + needleName.length;
        }
      }

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
