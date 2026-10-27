import { collectEffectiveParameterNodes } from "@/lib/openapi/parameters";
import { collectDocumentOperations } from "@/lib/openapi/operations";
import { collectDocumentPathEntries } from "@/lib/openapi/paths";
import { appendPointer, isRecord, jsonPointer, resolveObjectReference } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { pathRange, sourceMap } from "@/lib/openapi/sourceMap";

/**
 * Collects header names and their logical locations from an OpenAPI spec.
 *
 * - Request headers: parameters with `in: header` (path-level and operation-level).
 * - Response headers: keys under `responses[*].headers` for each operation.
 *
 * Local parameter, Path Item and response references retain declaration pointers.
 */
export function collectHeaderLocations(spec: unknown): HeaderLocation[] {
  const out: HeaderLocation[] = [];
  if (!isRecord(spec) || !isRecord(spec.paths)) return out;
  const cache = new Map<string, unknown>();
  const requestHeaders = (parent: unknown, pointer: string, logical: string) => {
    if (!isRecord(parent) || parent.parameters === undefined) return;
    if (!Array.isArray(parent.parameters)) {
      throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(pointer, "parameters"), "Expected a parameters array");
    }
    parent.parameters.forEach((raw: unknown, index: number) => {
      const source = appendPointer(pointer, "parameters", index);
      const param = resolveObjectReference(raw, spec, cache, source);
      if (!param) throw new NativeAccessorError("INVALID_DECLARATION", source, "Expected a parameter object");
      if (param.value.in !== "header" || typeof param.value.name !== "string") return;
      out.push({
        headerName: param.value.name,
        jsonPointer: `${logical}.parameters[${index}].name`,
        sourcePointer: appendPointer(param.pointer, "name"), direction: "request",
      });
    });
  };
  for (const [path, raw] of collectDocumentPathEntries(spec)) {
    const item = resolveObjectReference(raw, spec, cache, jsonPointer(["paths", path]), "reject");
    if (item) requestHeaders(item.value, item.pointer, `paths.${path}`);
  }
  for (const op of collectDocumentOperations(spec)) {
    requestHeaders(op.operation, op.pointer, `paths.${op.path}.${op.method}`);
    if (op.operation.responses === undefined) continue;
    if (!isRecord(op.operation.responses)) {
      throw new NativeAccessorError("INVALID_DECLARATION", op.pointer, "Expected a responses object");
    }
    for (const [status, raw] of Object.entries(op.operation.responses)) {
      if (status.startsWith("x-")) continue;
      const pointer = appendPointer(op.pointer, "responses", status);
      const response = resolveObjectReference(raw, spec, cache, pointer);
      if (!response) throw new NativeAccessorError("INVALID_DECLARATION", pointer, "Expected a response object");
      const headers = response.value.headers;
      if (headers === undefined) continue;
      if (!isRecord(headers)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(response.pointer, "headers"), "Expected a headers object");
      }
      for (const name of Object.keys(headers)) out.push({
        headerName: name, jsonPointer: `paths.${op.path}.${op.method}.responses.${status}.headers.${name}`,
        sourcePointer: appendPointer(response.pointer, "headers", name), direction: "response",
      });
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
