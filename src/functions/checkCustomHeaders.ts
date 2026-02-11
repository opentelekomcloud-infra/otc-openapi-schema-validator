import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

type HeaderLocation = {
  headerName: string;
  jsonPointer: string;
};

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const DEFAULT_STANDARD_HEADERS = new Set(
  [
    "accept",
    "authorization",
  ].map((h) => h.toLowerCase())
);

function safeRegex(pattern?: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function isCustomHeader(
  headerName: string,
  standardHeaders: Set<string>,
): boolean {
  const lower = headerName.toLowerCase();

  // Treat known / explicitly provided standard headers as non-custom.
  if (standardHeaders.has(lower)) return false;

  // Everything else is treated as a custom header candidate and must match the regex.
  return true;
}

function collectHeaderLocations(spec: any): HeaderLocation[] {
  const out: HeaderLocation[] = [];
  if (!spec?.paths || typeof spec.paths !== "object") return out;

  for (const [pathKey, pathItem] of Object.entries<any>(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    // Path-level parameters
    if (Array.isArray(pathItem.parameters)) {
      pathItem.parameters.forEach((p: any, idx: number) => {
        if (p?.in === "header" && typeof p?.name === "string") {
          out.push({
            headerName: p.name,
            jsonPointer: `paths.${pathKey}.parameters[${idx}].name`,
          });
        }
      });
    }

    for (const [maybeMethod, op] of Object.entries<any>(pathItem)) {
      if (!HTTP_METHODS.has(maybeMethod)) continue;
      if (!op || typeof op !== "object") continue;

      if (Array.isArray(op.parameters)) {
        op.parameters.forEach((p: any, idx: number) => {
          if (p?.in === "header" && typeof p?.name === "string") {
            out.push({
              headerName: p.name,
              jsonPointer: `paths.${pathKey}.${maybeMethod}.parameters[${idx}].name`,
            });
          }
        });
      }

      const responses = op.responses;
      if (responses && typeof responses === "object") {
        for (const [statusCode, resp] of Object.entries<any>(responses)) {
          const headers = resp?.headers;
          if (!headers || typeof headers !== "object") continue;
          for (const headerName of Object.keys(headers)) {
            out.push({
              headerName,
              jsonPointer: `paths.${pathKey}.${maybeMethod}.responses.${statusCode}.headers.${headerName}`,
            });
          }
        }
      }
    }
  }

  return out;
}

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
