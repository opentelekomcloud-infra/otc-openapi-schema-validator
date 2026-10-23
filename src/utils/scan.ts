import { resolveLocalRef } from "@/utils/schema";
import { collectEffectiveParameterNodes } from "@/lib/openapi/parameters";
import { collectDocumentOperations } from "@/lib/openapi/operations";
import { jsonPointer } from "@/lib/openapi/references";
import { pathRange, sourceMap } from "@/lib/openapi/sourceMap";

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
            sourcePointer: jsonPointer(["paths", pathKey, "parameters", idx, "name"]),
            direction: "request",
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
              sourcePointer: jsonPointer(["paths", pathKey, maybeMethod, "parameters", idx, "name"]),
              direction: "request",
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
              sourcePointer: jsonPointer(["paths", pathKey, maybeMethod, "responses", statusCode, "headers", headerName]),
              direction: "response",
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
  sourcePointer: string;
  direction: "request" | "response";
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
 * Legacy cursor API: only a unique source key can be located without a pointer.
 * Response consumers should use their complete operation/response pointer.
 */
export function findNextStatusCodeRange(
  content: string,
  statusCode: string,
  fromIndex: number
): { from: number; to: number } {
  return sourceMap(content).findKey(statusCode, fromIndex);
}

/**
 * Locates the actual path key in the YAML/JSON source tree.
 */
export function findPathKeyRangeInPathsBlock(content: string, pathKey: string): { from: number; to: number } {
  return pathRange(content, pathKey);
}

/**
 * Collects query parameters for an operation, preserving list order.
 * Operation parameters override matching path parameters; resolves local `$ref` chains.
 */
export function collectQueryParams(
  pathItem: any,
  operation: any,
  spec: any,
  refCache: Map<string, any>
): { name: string; index: number; raw: any }[] {
  return collectEffectiveParameterNodes(pathItem, operation, spec, refCache)
    .map(({ parameter }, index) => ({
      name: String(parameter.name).toLowerCase(), index, raw: parameter,
    }))
    .filter(({ raw }) => String(raw.in).toLowerCase() === "query");
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
  const allowedMethods = Array.isArray(configuredMethods)
    ? configuredMethods.map((m) => String(m).toLowerCase())
    : ["get", "post", "put", "patch", "delete"];

  return collectDocumentOperations(spec, allowedMethods);
}
