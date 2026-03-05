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

function decodeJsonPointerToken(token: string): string {
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

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
 * Returns true if `propName` exists as a property key anywhere inside the resolved schema.
 * Traverses objects/arrays and composition keywords. Avoids cycles with `visited`.
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

export function schemaIsObject(schema: any, spec: any, refCache: Map<string, any>): boolean {
    const s = resolveRefDeep(schema, refCache, spec);
    if (!s || typeof s !== "object") return false;
    return String((s as any).type ?? "").toLowerCase() === "object" || !!(s as any).properties;
}

export function schemaIsArrayOfObjects(schema: any, spec: any, refCache: Map<string, any>): boolean {
    const s = resolveRefDeep(schema, refCache, spec);
    if (!s || typeof s !== "object") return false;
    if (String((s as any).type ?? "").toLowerCase() !== "array") return false;
    const items = (s as any).items;
    if (!items) return false;
    return schemaIsObject(items, spec, refCache);
}

/**
 * Returns true if schema is an object wrapper that contains ANY property that is `array<object>`.
 * This covers shapes like `{ service_items: [ {...}, ... ] }`, `{ tags: [ ... ] }`, etc.
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

export type PayloadConfig = {
    allowTopLevelArray?: boolean;
    allowObjectWrapperWithAnyArrayOfObjects?: boolean;
    allowActionEnumCreateDeleteWithTagsArray?: boolean;
    contentTypesPreferred?: string[];
};

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
 * Extracts requestBody schema from an OpenAPI 3 operation.
 * Prefers JSON, then XML, otherwise first available media type.
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
