import { PayloadConfig, SyncGranularityConfig } from "@/types/batch";
import { getResponseObjectByStatus, isPlainObject } from "@/utils/spec";

/**
 * Validates that a parameter matches expected schema conditions.
 *
 * Supports resolving `$ref` parameters from `#/components/...`.
 * Handles both `schema` and OpenAPI `content` parameter styles.
 *
 * Validation includes:
 * - parameter name
 * - `in` location (query/header/path/cookie)
 * - parameter type
 * - optional constraints such as `required`, `description`, and `style`
 *
 * @param param Parameter object or `$ref`
 * @param name Expected parameter name
 * @param paramIn Parameter location (`query`, `header`, `path`, etc.)
 * @param type Expected schema type
 * @param spec Full OpenAPI specification (used for `$ref` resolution)
 * @param options Optional validation constraints
 * @returns true if parameter matches the expected schema
 */
export function matchParameterSchema(
    param: any,
    name: string,
    paramIn: string,
    type: string,
    spec: any,
    options?: {
        required?: boolean;
        description?: boolean;
        style?: string;
    }
): boolean {
    if (!param || typeof param !== "object") return false;
    if (typeof param["$ref"] === "string" && param["$ref"].startsWith("#/")) {
        const refPath = param["$ref"].slice(2).split("/");
        let resolved = spec;
        for (const part of refPath) {
            if (resolved instanceof Map) {
                resolved = resolved.get(part);
            } else if (typeof resolved === "object") {
                resolved = resolved[part];
            } else {
                return false;
            }
        }
        if (!resolved) return false;
        param = resolved;
    }

    const nameMatches =
        paramIn === "header"
            ? String(param.name ?? "").toLowerCase() === String(name).toLowerCase()
            : param.name === name;

    const schemaType = param.schema?.type;

    // OpenAPI 3 allows parameters to use `content` with media types instead of `schema`.
    let contentType: any = undefined;
    const contentObj = param.content;
    if (contentObj && typeof contentObj === "object") {
        const media =
            contentObj["application/json"] ??
            contentObj["application/xml"] ??
            contentObj[Object.keys(contentObj)[0]];
        contentType = media?.schema?.type;
    }

    const matchesBase = nameMatches && param.in === paramIn && (schemaType === type || contentType === type);

    if (!matchesBase) return false;

    if (options?.required !== undefined && param.required !== options.required) return false;
    if (options?.description && !param.description) return false;
    if (options?.style && param.style !== options.style) return false;

    return true;
}

/**
 * Resolves a local OpenAPI JSON pointer reference (`#/...`).
 *
 * Works with both plain objects and Map-based structures used in some parsers.
 *
 * @param ref JSON pointer reference
 * @param spec OpenAPI specification
 * @returns resolved object or undefined if resolution fails
 */
export const resolveRef = (ref: string, spec: any): any => {
    if (!ref || !ref.startsWith('#/')) return undefined;
    const refPath = ref.slice(2).split('/');
    let resolved = spec;
    for (const part of refPath) {
        if (resolved instanceof Map) {
            resolved = resolved.get(part);
        } else if (typeof resolved === 'object') {
            resolved = resolved[part];
        } else {
            return undefined;
        }
    }
    return resolved;
};

/**
 * Recursively extracts all property names from a schema.
 *
 * Traverses nested objects, arrays and `$ref` references.
 *
 * Useful when validating that response models contain certain fields.
 *
 * @param schema Root schema
 * @param spec OpenAPI specification used for resolving references
 * @returns Set of property names discovered in the schema
 */
export function extractAllProperties(schema: any, spec: any): Set<string> {
    const props = new Set<string>();

    function walk(node: any) {
        if (!node) return;

        if (node.$ref) {
            const resolved = resolveRef(node.$ref, spec);
            walk(resolved);
            return;
        }

        if (node.type === 'object' && node.properties) {
            for (const key in node.properties) {
                props.add(key);
                walk(node.properties[key]);
            }
        } else if (node.type === 'array' && node.items) {
            walk(node.items);
        }
    }

    walk(schema);
    return props;
}

/**
 * Normalizes a schema node into a readable type string.
 *
 * Handles `$ref`, arrays and implicit object definitions.
 *
 * Examples:
 *   object
 *   string
 *   array<object>
 *
 * @param node Schema node
 * @param spec OpenAPI specification
 * @returns normalized type string
 */
export function normalizeType(node: any, spec: any): string {
    if (!node) return 'unknown';
    if (node.$ref) {
        const resolved = resolveRef(node.$ref, spec);
        return normalizeType(resolved, spec);
    }
    if (node.type === 'array') {
        const itemType = normalizeType(node.items, spec);
        return `array<${itemType}>`;
    }
    if (node.type) {
        return String(node.type);
    }
    if (node.properties) return 'object';
    if (node.items) return `array<${normalizeType(node.items, spec)}>`;
    return 'unknown';
}

/**
 * Traverses a schema and returns a mapping of property paths to types.
 *
 * Paths are expressed using dot notation and [] for arrays.
 *
 * Example:
 *   user.id -> string
 *   users[].name -> string
 *
 * @param schema Root schema
 * @param spec OpenAPI specification
 * @param basePath Optional path prefix
 * @returns Map of property path -> normalized type
 */
export function extractPropertyTypes(schema: any, spec: any, basePath = ''): Map<string, string> {
    const types = new Map<string, string>();

    function walk(node: any, currentPath: string) {
        if (!node) return;
        if (node.$ref) {
            const resolved = resolveRef(node.$ref, spec);
            walk(resolved, currentPath);
            return;
        }

        // record the type of the current node if it's a leaf or an explicitly typed node
        if (currentPath) {
            types.set(currentPath, normalizeType(node, spec));
        }

        if (node.type === 'object' && node.properties) {
            for (const key in node.properties) {
                const nextPath = currentPath ? `${currentPath}.${key}` : key;
                walk(node.properties[key], nextPath);
            }
        } else if (node.type === 'array' && node.items) {
            // Also descend into array items to capture nested structure
            const nextPath = currentPath ? `${currentPath}[]` : '[]';
            walk(node.items, nextPath);
        }
    }

    walk(schema, basePath);
    return types;
}

/**
 * Traverses a schema and extracts enum values.
 *
 * Supports nested objects, arrays and `$ref` resolution.
 *
 * @param schema Root schema
 * @param spec OpenAPI specification
 * @param basePath Optional path prefix
 * @returns Map of property path -> enum value set
 */
export function extractEnumIfExist(schema: any, spec: any, basePath = ''): Map<string, Set<string>> {
    const enums = new Map<string, Set<string>>();

    function walk(node: any, currentPath: string) {
        if (!node) return;
        if (node.$ref) {
            const resolved = resolveRef(node.$ref, spec);
            walk(resolved, currentPath);
            return;
        }

        if (Array.isArray(node.enum)) {
            const values = new Set<string>(node.enum.map((v: any) => String(v)));
            if (currentPath) enums.set(currentPath, values);
        }

        if (node.type === 'object' && node.properties) {
            for (const key in node.properties) {
                const nextPath = currentPath ? `${currentPath}.${key}` : key;
                walk(node.properties[key], nextPath);
            }
        } else if (node.type === 'array' && node.items) {
            const nextPath = currentPath ? `${currentPath}[]` : '[]';
            walk(node.items, nextPath);
        }
    }

    walk(schema, basePath);
    return enums;
}

/**
 * Decodes a single JSON Pointer token according to RFC 6901.
 *
 * Replaces escaped sequences:
 * - `~1` -> `/`
 * - `~0` -> `~`
 *
 * Used when resolving local `$ref` paths that may contain escaped characters.
 *
 * @param token Raw JSON Pointer token.
 * @returns Decoded token value.
 */
function decodeJsonPointerToken(token: string): string {
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Resolves chained `$ref` references until a concrete schema object is reached.
 *
 * Includes caching and circular reference protection.
 *
 * @param obj Schema node that may contain `$ref`
 * @param refCache Cache for resolved references
 * @param spec OpenAPI specification
 * @returns resolved schema node
 */
export function resolveRefDeep(obj: any, refCache: any, spec: any): any {
    let curObj: any = obj;
    const seen = new Set<string>();

    while (curObj && typeof curObj === "object" && typeof curObj.$ref === "string") {
        const ref: string = curObj.$ref;
        const cached = refCache.get(ref);
        if (cached) {
            curObj = cached;
            continue;
        }
        if (!ref.startsWith("#/")) return curObj;
        if (seen.has(ref)) return curObj;
        seen.add(ref);

        const parts = ref
          .slice(2)
          .split("/")
          .filter(Boolean)
          .map(decodeJsonPointerToken);

        let resolved: any = spec;
        for (const p of parts) {
            if (!resolved || typeof resolved !== "object") {
                resolved = null;
                break;
            }
            resolved = resolved[p];
        }

        if (!resolved) return curObj;
        refCache.set(ref, resolved);
        curObj = resolved;
    }

    return curObj;
}

/**
 * Resolves a single local `$ref` object if present.
 *
 * If resolution fails the original object is returned.
 *
 * @param spec OpenAPI specification
 * @param maybeRefObj Object that may contain `$ref`
 * @returns resolved object or original input
 */
export function resolveLocalRef(spec: any, maybeRefObj: any): any {
    if (!maybeRefObj || typeof maybeRefObj !== "object") return maybeRefObj;

    const ref = maybeRefObj["$ref"];
    if (typeof ref !== "string" || !ref.startsWith("#/")) return maybeRefObj;

    const refPath = ref.slice(2).split("/");
    let resolved: any = spec;

    for (const part of refPath) {
        if (resolved instanceof Map) {
            resolved = resolved.get(part);
        } else if (resolved && typeof resolved === "object") {
            resolved = (resolved as any)[part];
        } else {
            return maybeRefObj;
        }
    }

    // If resolution fails, fall back to original object.
    return resolved ?? maybeRefObj;
}

/**
 * Checks whether a property exists anywhere inside a schema.
 *
 * Traverses:
 * - nested objects
 * - arrays
 * - additionalProperties
 * - composition keywords (`allOf`, `oneOf`, `anyOf`)
 *
 * Uses a visited set to prevent infinite recursion.
 *
 * @param schema Schema to inspect
 * @param propName Property name to search
 * @param spec OpenAPI specification
 * @param refCache Reference cache
 * @param visited Cycle detection set
 * @returns true if property exists
 */
export function schemaHasPropertyDeep(
  schema: any,
  propName: string,
  spec: any,
  refCache: Map<string, any>,
  visited: Set<any>
): boolean {
    if (!schema || typeof schema !== "object") return false;

    const resolved = resolveRefDeep(schema, refCache, spec);
    if (!resolved || typeof resolved !== "object") return false;

    if (visited.has(resolved)) return false;
    visited.add(resolved);

    const props = (resolved as any).properties;
    if (props && typeof props === "object") {
        if (Object.prototype.hasOwnProperty.call(props, propName)) return true;
        // also consider case-insensitive match in case of style differences
        const lower = propName.toLowerCase();
        for (const k of Object.keys(props)) {
            if (k.toLowerCase() === lower) return true;
        }

        // Dive into properties
        for (const v of Object.values(props)) {
            if (schemaHasPropertyDeep(v, propName, spec, refCache, visited)) return true;
        }
    }

    // Arrays
    const items = (resolved as any).items;
    if (items) {
        if (schemaHasPropertyDeep(items, propName, spec, refCache, visited)) return true;
    }

    // additionalProperties may be a schema
    const addl = (resolved as any).additionalProperties;
    if (addl && typeof addl === "object") {
        if (schemaHasPropertyDeep(addl, propName, spec, refCache, visited)) return true;
    }

    // Composition
    for (const key of ["allOf", "oneOf", "anyOf"]) {
        const arr = (resolved as any)[key];
        if (Array.isArray(arr)) {
            for (const s of arr) {
                if (schemaHasPropertyDeep(s, propName, spec, refCache, visited)) return true;
            }
        }
    }

    // Not found
    return false;
}

/**
 * Determines whether a schema represents an object.
 *
 * Supports `$ref` resolution and implicit object definitions via `properties`.
 */
export function schemaIsObject(schema: any, spec: any, refCache: Map<string, any>): boolean {
    const s = resolveRefDeep(schema, refCache, spec);
    if (!s || typeof s !== "object") return false;
    return String((s as any).type ?? "").toLowerCase() === "object" || !!(s as any).properties;
}

/**
 * Determines whether a schema represents `array<object>`.
 *
 * Used when validating batch payload structures.
 */
export function schemaIsArrayOfObjects(schema: any, spec: any, refCache: Map<string, any>): boolean {
    const s = resolveRefDeep(schema, refCache, spec);
    if (!s || typeof s !== "object") return false;
    if (String((s as any).type ?? "").toLowerCase() !== "array") return false;
    const items = (s as any).items;
    if (!items) return false;
    return schemaIsObject(items, spec, refCache);
}

/**
 * Detects whether a schema contains any property that is `array<object>`.
 *
 * Covers wrapper patterns such as:
 *   { items: [...] }
 *   { resources: [...] }
 *   { service_items: [...] }
 *
 * Used for detecting batch-style request payloads.
 */
export function schemaHasAnyArrayOfObjectsDeep(schema: any, spec: any, refCache: Map<string, any>): boolean {
    const s = resolveRefDeep(schema, refCache, spec);
    if (!s || typeof s !== "object") return false;

    const visited = new Set<any>();

    const visit = (node: any): boolean => {
        const n = resolveRefDeep(node, refCache, spec);
        if (!n || typeof n !== "object") return false;
        if (visited.has(n)) return false;
        visited.add(n);

        if (schemaIsArrayOfObjects(n, spec, refCache)) return true;

        const props = (n as any).properties;
        if (props && typeof props === "object") {
            for (const v of Object.values(props)) {
                if (visit(v)) return true;
            }
        }

        const items = (n as any).items;
        if (items && visit(items)) return true;

        const addl = (n as any).additionalProperties;
        if (addl && typeof addl === "object" && visit(addl)) return true;

        for (const key of ["allOf", "oneOf", "anyOf"]) {
            const arr = (n as any)[key];
            if (Array.isArray(arr)) {
                for (const sub of arr) {
                    if (visit(sub)) return true;
                }
            }
        }

        return false;
    };

    return visit(s);
}

/**
 * Selects the most suitable media type object from an OpenAPI `content` map.
 *
 * The function prefers media types in the provided order and falls back to the
 * first available content entry if none of the preferred types exist.
 *
 * @param contentObj OpenAPI `content` object.
 * @param preferred Ordered list of preferred media types.
 * @returns The selected media type definition or null if none is available.
 */
function pickPreferredMediaType(contentObj: any, preferred: string[]): any {
    if (!contentObj || typeof contentObj !== "object") return null;

    const keys = Object.keys(contentObj);
    if (keys.length === 0) return null;

    for (const p of preferred) {
        if (contentObj[p]) return contentObj[p];
    }

    // fallback to first media type
    return contentObj[keys[0]];
}

/**
 * Extracts the requestBody schema from an OpenAPI operation.
 *
 * Media type selection prefers configured types
 * (JSON → problem+json → XML → fallback).
 *
 * Automatically resolves `$ref` chains.
 *
 * @returns resolved schema or null
 */
export function getRequestBodySchema(
  operation: any,
  spec: any,
  refCache: Map<string, any>,
  payloadCfg?: PayloadConfig
): any | null {
    const rbRaw = operation?.requestBody;
    if (!rbRaw) return null;

    const rb = resolveRefDeep(rbRaw, refCache, spec);
    if (!rb || typeof rb !== "object") return null;

    const contentObj = (rb as any).content;
    if (!contentObj || typeof contentObj !== "object") return null;

    const preferred =
      Array.isArray(payloadCfg?.contentTypesPreferred) && payloadCfg!.contentTypesPreferred!.length > 0
        ? payloadCfg!.contentTypesPreferred!
        : ["application/json", "application/problem+json", "application/xml"];

    const media = pickPreferredMediaType(contentObj, preferred);
    const schema = media?.schema;
    if (!schema) return null;

    return resolveRefDeep(schema, refCache, spec);
}

/**
 * Extracts the schema from the primary success response (200).
 *
 * Filters media types according to configured preferences.
 *
 * Used by response validation rules.
 */
export function getResponseSchema(
  operation: any,
  spec: any,
  refCache: Map<string, any>,
  cfg: SyncGranularityConfig
): any | null {
    const respRaw = getSuccessResponseObject(operation);
    if (!respRaw) return null;

    const resp = resolveRefDeep(respRaw, refCache, spec);
    if (!resp || typeof resp !== "object") return null;

    const contentObj = (resp as any).content;
    if (!contentObj || typeof contentObj !== "object") {
        return null;
    }

    const preferred = Array.isArray(cfg.contentTypes) && cfg.contentTypes.length > 0
      ? cfg.contentTypes
      : ["application/json", "application/problem+json"];

    const media = pickPreferredMediaType(contentObj, preferred);
    const schema = media?.schema;
    if (!schema) return null;

    return resolveRefDeep(schema, refCache, spec);
}

/**
 * Returns the primary success response object for an operation.
 *
 * Currently, this helper checks for `200` using both string and numeric keys,
 * because parsers may normalize response codes differently.
 *
 * @param operation OpenAPI operation object.
 * @returns The success response object or null if no 200 response exists.
 */
function getSuccessResponseObject(operation: any): any | null {
    const responses = operation?.responses;
    if (!responses || typeof responses !== "object") return null;
    return (responses as any)["200"] ?? (responses as any)[200] ?? null;
}

/**
 * Checks whether a response contains `content` entries
 * for configured media types.
 *
 * Helps skip validation when operations return no body
 * (e.g. 204 responses).
 */
export function schemaHasContentForConfiguredTypes(operation: any, cfg: SyncGranularityConfig): boolean {
    const resp = getSuccessResponseObject(operation);
    if (!resp || typeof resp !== "object") return false;

    const contentObj = (resp as any).content;
    if (!contentObj || typeof contentObj !== "object") return false;

    const preferred = Array.isArray(cfg.contentTypes) && cfg.contentTypes.length > 0
      ? cfg.contentTypes
      : ["application/json", "application/problem+json"];

    return preferred.some((t) => Boolean((contentObj as any)[t]));
}

/**
 * Recursively searches for a property schema by name.
 *
 * Supports `$ref`, arrays, additionalProperties and
 * composition constructs.
 *
 * @returns the schema node if found
 */
export function findFieldSchemaByNameDeep(
  schema: any,
  names: string[],
  spec: any,
  refCache: Map<string, any>,
  visited: Set<any>
): any | null {
    const resolved = resolveRefDeep(schema, refCache, spec);
    if (!resolved || typeof resolved !== "object") return null;
    if (visited.has(resolved)) return null;
    visited.add(resolved);

    const wanted = names.map((n) => String(n).toLowerCase());
    const props = (resolved as any).properties;
    if (props && typeof props === "object") {
        for (const [k, v] of Object.entries(props)) {
            if (wanted.includes(String(k).toLowerCase())) return v;
        }
        for (const v of Object.values(props)) {
            const nested = findFieldSchemaByNameDeep(v, names, spec, refCache, visited);
            if (nested) return nested;
        }
    }

    const items = (resolved as any).items;
    if (items) {
        const nested = findFieldSchemaByNameDeep(items, names, spec, refCache, visited);
        if (nested) return nested;
    }

    const addl = (resolved as any).additionalProperties;
    if (addl && typeof addl === "object") {
        const nested = findFieldSchemaByNameDeep(addl, names, spec, refCache, visited);
        if (nested) return nested;
    }

    for (const key of ["allOf", "oneOf", "anyOf"]) {
        const arr = (resolved as any)[key];
        if (Array.isArray(arr)) {
            for (const s of arr) {
                const nested = findFieldSchemaByNameDeep(s, names, spec, refCache, visited);
                if (nested) return nested;
            }
        }
    }

    return null;
}

/**
 * Checks whether a schema contains any property
 * from a provided list of candidate names.
 */
export function schemaHasPropertyAnyOf(
  schema: any,
  names: string[],
  spec: any,
  refCache: Map<string, any>,
  visited: Set<any>
): boolean {
    return Boolean(findFieldSchemaByNameDeep(schema, names, spec, refCache, visited));
}

/**
 * Determines whether a schema behaves like an array.
 *
 * Accepts both explicit `type: array` and implicit
 * schemas containing `items`.
 */
export function schemaIsArrayLike(schema: any, spec: any, refCache: Map<string, any>): boolean {
    const s = resolveRefDeep(schema, refCache, spec);
    if (!s || typeof s !== "object") return false;
    return String((s as any).type ?? "").toLowerCase() === "array" || Boolean((s as any).items);
}

/**
 * Checks whether items of an array schema contain
 * one of the configured status fields.
 *
 * Used for validating per-item batch operation responses.
 */
export function arrayItemsHaveStatusField(
  arraySchema: any,
  statusFields: string[],
  spec: any,
  refCache: Map<string, any>
): boolean {
    const arr = resolveRefDeep(arraySchema, refCache, spec);
    if (!arr || typeof arr !== "object") return false;
    const items = (arr as any).items;
    if (!items) return false;
    return schemaHasPropertyAnyOf(items, statusFields, spec, refCache, new Set<any>());
}

/**
 * Resolves the response schema for a specific HTTP status code.
 *
 * Unlike the generic response-schema helper that defaults to the primary success
 * response, this function is status-code aware and is used by async rules where
 * the contract is tied to a specific response such as 202 Accepted.
 *
 * @param operation OpenAPI operation object
 * @param statusCode Response status code to inspect
 * @param spec OpenAPI specification
 * @param refCache Reference resolution cache
 * @returns resolved response schema or null if absent
 */
export function getResponseSchemaByStatus(
  operation: any,
  statusCode: string,
  spec: any,
  refCache: Map<string, any>
): any | null {
    const respRaw = getResponseObjectByStatus(operation, statusCode);
    if (!respRaw) return null;

    const resp = resolveRefDeep(respRaw, refCache, spec);
    if (!resp || typeof resp !== "object") return null;

    const contentObj = (resp as any).content;
    if (!contentObj || typeof contentObj !== "object") return null;

    const preferred = ["application/json", "application/problem+json", "application/xml"];
    for (const mediaType of preferred) {
        const media = (contentObj as any)[mediaType];
        if (media?.schema) {
            return resolveRefDeep(media.schema, refCache, spec);
        }
    }

    const firstKey = Object.keys(contentObj)[0];
    const firstMedia = firstKey ? (contentObj as any)[firstKey] : null;
    if (firstMedia?.schema) {
        return resolveRefDeep(firstMedia.schema, refCache, spec);
    }

    return null;
}

/**
 * Collects all reachable property paths from a schema.
 *
 * Traverses nested objects, arrays and composition constructs (`allOf`, `oneOf`, `anyOf`),
 * resolving `$ref` links along the way.
 *
 * Paths use dot notation for objects and `[]` for arrays.
 * Example:
 * - `user.id`
 * - `items[]`
 * - `items[].name`
 *
 * @param schema Root schema to inspect.
 * @param spec OpenAPI specification.
 * @param refCache Reference cache used by `$ref` resolution.
 * @param basePath Optional path prefix.
 * @param visited Cycle-detection set.
 * @returns Set of discovered schema paths.
 */
export function collectSchemaPaths(schema: any, spec: any, refCache: Map<string, any>, basePath = "", visited = new Set<any>()): Set<string> {
    const result = new Set<string>();
    const resolved = resolveRefDeep(schema, refCache, spec);
    if (!resolved || typeof resolved !== "object") return result;
    if (visited.has(resolved)) return result;
    visited.add(resolved);

    const props = (resolved as any).properties;
    if (props && typeof props === "object") {
        for (const [key, value] of Object.entries(props)) {
            const nextPath = basePath ? `${basePath}.${key}` : key;
            result.add(nextPath);
            const childPaths = collectSchemaPaths(value, spec, refCache, nextPath, visited);
            for (const p of childPaths) result.add(p);
        }
    }

    const items = (resolved as any).items;
    if (items) {
        const nextBase = `${basePath}[]`;
        result.add(nextBase);
        const childPaths = collectSchemaPaths(items, spec, refCache, nextBase, visited);
        for (const p of childPaths) result.add(p);
    }

    for (const key of ["allOf", "oneOf", "anyOf"]) {
        const arr = (resolved as any)[key];
        if (Array.isArray(arr)) {
            for (const part of arr) {
                const childPaths = collectSchemaPaths(part, spec, refCache, basePath, visited);
                for (const p of childPaths) result.add(p);
            }
        }
    }

    return result;
}

/**
 * Collects all required field paths from a schema.
 *
 * Traverses nested objects, arrays and composition constructs while resolving `$ref` links.
 * Only fields listed in `required` arrays are included at each level.
 *
 * Paths use dot notation for objects and `[]` for arrays.
 *
 * @param schema Root schema to inspect.
 * @param spec OpenAPI specification.
 * @param refCache Reference cache used by `$ref` resolution.
 * @param basePath Optional path prefix.
 * @param visited Cycle-detection set.
 * @returns Set of required schema paths.
 */
export function collectRequiredSchemaPaths(schema: any, spec: any, refCache: Map<string, any>, basePath = "", visited = new Set<any>()): Set<string> {
    const result = new Set<string>();
    const resolved = resolveRefDeep(schema, refCache, spec);
    if (!resolved || typeof resolved !== "object") return result;
    if (visited.has(resolved)) return result;
    visited.add(resolved);

    const required = Array.isArray((resolved as any).required) ? (resolved as any).required : [];
    const props = (resolved as any).properties;

    if (props && typeof props === "object") {
        for (const key of required) {
            const nextPath = basePath ? `${basePath}.${key}` : key;
            result.add(nextPath);
        }

        for (const [key, value] of Object.entries(props)) {
            const nextPath = basePath ? `${basePath}.${key}` : key;
            const childPaths = collectRequiredSchemaPaths(value, spec, refCache, nextPath, visited);
            for (const p of childPaths) result.add(p);
        }
    }

    const items = (resolved as any).items;
    if (items) {
        const nextBase = `${basePath}[]`;
        const childPaths = collectRequiredSchemaPaths(items, spec, refCache, nextBase, visited);
        for (const p of childPaths) result.add(p);
    }

    for (const key of ["allOf", "oneOf", "anyOf"]) {
        const arr = (resolved as any)[key];
        if (Array.isArray(arr)) {
            for (const part of arr) {
                const childPaths = collectRequiredSchemaPaths(part, spec, refCache, basePath, visited);
                for (const p of childPaths) result.add(p);
            }
        }
    }

    return result;
}

/**
 * Collects all field paths present in an example payload.
 *
 * Traverses nested objects and arrays and produces paths using dot notation
 * for objects and `[]` for arrays.
 *
 * Example:
 * - `user.id`
 * - `items[]`
 * - `items[].name`
 *
 * This helper is used to compare example payload structure with schema-defined paths.
 *
 * @param value Example payload value.
 * @param basePath Optional path prefix.
 * @returns Set of discovered example paths.
 */
export function collectExamplePaths(value: any, basePath = ""): Set<string> {
    const result = new Set<string>();

    if (Array.isArray(value)) {
        const arrayPath = `${basePath}[]`;
        if (basePath) result.add(arrayPath);
        for (const item of value) {
            const childPaths = collectExamplePaths(item, arrayPath);
            for (const p of childPaths) result.add(p);
        }
        return result;
    }

    if (!isPlainObject(value)) return result;

    for (const [key, child] of Object.entries(value)) {
        const nextPath = basePath ? `${basePath}.${key}` : key;
        result.add(nextPath);
        const childPaths = collectExamplePaths(child, nextPath);
        for (const p of childPaths) result.add(p);
    }

    return result;
}
