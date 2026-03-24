import {resolveLocalRef, resolveRefDeep} from "@/utils/schema";

/**
 * Collects header names and their logical locations from an OpenAPI spec.
 *
 * - Request headers: parameters with `in: header` (path-level and operation-level).
 * - Response headers: keys under `responses[*].headers` for each operation.
 *
 * `$ref` parameters are resolved via `resolveLocalRef`.
 */
export function collectHeaderLocations(spec: any): HeaderLocation[] {
  const out: HeaderLocation[] = [];
  if (!spec?.paths || typeof spec.paths !== "object") return out;

  for (const [pathKey, pathItem] of Object.entries<any>(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    // Path-level parameters
    if (Array.isArray(pathItem.parameters)) {
      pathItem.parameters.forEach((p: any, idx: number) => {
        const param = resolveLocalRef(spec, p);
        if (param?.in === "header" && typeof param?.name === "string") {
          out.push({
            headerName: param.name,
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
          const param = resolveLocalRef(spec, p);
          if (param?.in === "header" && typeof param?.name === "string") {
            out.push({
              headerName: param.name,
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


/**
 * YAML-only: finds the next response status code key line after `fromIndex`.
 * Matches lines like:
 *   200:
 *   "200":
 *   '200':
 * Returns a range that highlights only the status code token.
 */
export function findNextStatusCodeRange(
  content: string,
  statusCode: string,
  fromIndex: number
): { from: number; to: number } {
  // Start scanning at the provided cursor position. The caller already advances the cursor
  // to the start of the next line after a match, so we must NOT skip another line here.
  let lineStart = fromIndex;

  // Ensure we start at a line boundary.
  const prevNl = content.lastIndexOf("\n", Math.max(0, lineStart - 1));
  if (prevNl !== -1) lineStart = prevNl + 1;
  else lineStart = 0;

  // Example matches: 200:, "200":, '200':
  // Escape the code to be safe for non-numeric keys like "2XX".
  const esc = statusCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(?:["']?)${esc}(?:["']?)\\s*:`);

  while (lineStart < content.length) {
    const lineEnd = content.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? content.length : lineEnd;
    const line = content.slice(lineStart, end);

    if (re.exec(line)) {
      const idxInLine = line.indexOf(statusCode);
      if (idxInLine !== -1) {
        const from = lineStart + idxInLine;
        return { from, to: from + statusCode.length };
      }
    }

    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return { from: 0, to: 0 };
}

/**
 * Best-effort YAML locator for a path key within the `paths:` section.
 *
 * Avoids matching occurrences of the same substring elsewhere in the spec
 * (e.g. inside `servers.url`).
 */
export function findPathKeyRangeInPathsBlock(content: string, pathKey: string): { from: number; to: number } {
  const pathsIdx = content.indexOf("\npaths:");
  const start = pathsIdx >= 0 ? pathsIdx : 0;

  const escaped = pathKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\r?\\n)\\s*(["']?)${escaped}\\2\\s*:`, "g");
  re.lastIndex = start;

  const m = re.exec(content);
  if (!m || m.index === undefined) return { from: 0, to: 0 };

  // Highlight only the path token, not indentation or quotes.
  const full = m[0];
  const inMatchIdx = full.lastIndexOf(pathKey);
  if (inMatchIdx === -1) return { from: 0, to: 0 };

  const from = m.index + inMatchIdx;
  return { from, to: from + pathKey.length };
}

/**
 * Collects query parameters for an operation, preserving list order.
 * Includes both `pathItem.parameters` and `operation.parameters` and resolves `$ref`.
 */
export function collectQueryParams(
  pathItem: any,
  operation: any,
  spec: any,
  refCache: Map<string, any>
): { name: string; index: number; raw: any }[] {
  const opParams = Array.isArray(operation?.parameters) ? operation.parameters : [];
  const pathParams = Array.isArray(pathItem?.parameters) ? pathItem.parameters : [];
  const allParams = [...pathParams, ...opParams];

  const out: { name: string; index: number; raw: any }[] = [];

  for (let i = 0; i < allParams.length; i++) {
    const resolved = resolveRefDeep(allParams[i], refCache, spec);
    if (!resolved || typeof resolved !== "object") continue;

    const inVal = String((resolved as any).in ?? "").toLowerCase();
    if (inVal !== "query") continue;

    const name = String((resolved as any).name ?? "");
    if (!name) continue;

    out.push({ name: name.toLowerCase(), index: i, raw: resolved });
  }

  return out;
}

/**
 * Collects OpenAPI operations filtered by HTTP method.
 *
 * The helper walks through `spec.paths`, keeps only valid HTTP method entries,
 * applies the optional `configuredMethods` filter, and returns normalized records
 * containing:
 * - `path`: the OpenAPI path key
 * - `method`: the lowercase HTTP method name
 * - `operation`: the operation object itself
 * - `pathItem`: the parent path item object
 *
 * This helper is useful for rules that need to iterate over operations in a
 * consistent way without repeating path/method traversal logic.
 *
 * @param spec OpenAPI specification object.
 * @param configuredMethods Optional list of HTTP methods to include.
 * @returns Array of collected operations with their path and parent path item.
 */
export function collectOperationMethods(spec: any, configuredMethods?: string[]): Array<{ path: string; method: string; operation: any; pathItem: any }> {
  const result: Array<{ path: string; method: string; operation: any; pathItem: any }> = [];
  const allowedMethods = Array.isArray(configuredMethods)
    ? configuredMethods.map((m) => String(m).toLowerCase())
    : ["get", "post", "put", "patch", "delete"];

  for (const path of Object.keys(spec?.paths ?? {})) {
    const pathItem = spec.paths[path];
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of Object.keys(pathItem)) {
      const lowered = String(method).toLowerCase();
      if (!allowedMethods.includes(lowered)) continue;
      if (!["get", "post", "put", "patch", "delete", "options", "head"].includes(lowered)) continue;

      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;
      result.push({ path, method: lowered, operation, pathItem });
    }
  }

  return result;
}
