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

    const matchesBase =
        param.name === name &&
        param.in === paramIn &&
        param.schema?.type === type;

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
