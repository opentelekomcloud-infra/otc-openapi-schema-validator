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