import { resolveLocalRef } from "@/utils/schema";

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
