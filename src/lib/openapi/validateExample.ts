import type { NativeParameterSchema } from "@/types/openapi";
import { NativeExampleError } from "./exampleError";
import { hasOwnField } from "./media";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "./references";

export interface ExampleIssue {
    readonly code: "type" | "enum" | "required" | "undefined" | "composition";
    readonly path: readonly (string | number)[];
    readonly detail: string;
}

export interface ExampleValidationOptions {
    readonly direction: "request" | "response";
    readonly checkTypes: boolean;
    readonly checkRequired: boolean;
    readonly forbidUndefined: boolean;
    readonly allowedRootProperties?: ReadonlySet<string>;
}

interface Clause extends NativeParameterSchema {
    readonly skipOneOf?: boolean;
    readonly skipAnyOf?: boolean;
}

export function assertJsonExample(value: unknown, pointer: string): void {
    const active = new Set<object>();
    const visit = (node: unknown) => {
        if (node === null || typeof node === "string" || typeof node === "boolean") return;
        if (typeof node === "number" && Number.isFinite(node)) return;
        if (!node || typeof node !== "object" ||
            (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null)) {
            throw new NativeExampleError(pointer, "Example is not a JSON-compatible value");
        }
        if (active.has(node)) throw new NativeExampleError(pointer, "Cyclic example value");
        active.add(node);
        Object.values(node).forEach(visit);
        active.delete(node);
    };
    visit(value);
}

function equalJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry, index) => equalJson(entry, b[index]));
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => hasOwnField(b, key) && equalJson(a[key], b[key]));
}

function typeOfSchema(node: Readonly<Record<string, unknown>>, pointer: string): string | undefined {
    if (typeof node.type === "string") return node.type;
    if (node.type !== undefined) throw new NativeExampleError(pointer, "Expected a single OpenAPI 2/3.0 schema type");
    if (isRecord(node.properties)) return "object";
    if (node.items !== undefined) return "array";
    return undefined;
}

export function expectsStructuredExample(
    declaration: NativeParameterSchema | undefined, document: unknown, cache: ReferenceCache,
): boolean {
    const active = new Set<object>();
    const types = (entry: NativeParameterSchema): Set<string> => {
        const resolved = resolveObjectReference(entry.node, document, cache, entry.pointer);
        if (!resolved) throw new NativeExampleError(entry.pointer, "Expected an example schema");
        if (active.has(resolved.value)) return new Set();
        const direct = typeOfSchema(resolved.value, resolved.pointer);
        if (direct) return new Set([direct]);
        active.add(resolved.value);
        const result = new Set<string>();
        for (const keyword of ["allOf", "oneOf", "anyOf"]) {
            const branches = resolved.value[keyword];
            if (!Array.isArray(branches)) continue;
            branches.forEach((node: unknown, index: number) => {
                if (!isRecord(node)) throw new NativeExampleError(resolved.pointer, "Expected a schema branch");
                for (const type of types({ node, pointer: appendPointer(resolved.pointer, keyword, index) })) result.add(type);
            });
        }
        active.delete(resolved.value);
        return result;
    };
    if (!declaration) return false;
    const expected = types(declaration);
    return expected.size > 0 && [...expected].every((type) => type === "object" || type === "array");
}

export function validateExampleValue(
    value: unknown, declaration: NativeParameterSchema, document: unknown, cache: ReferenceCache,
    options: ExampleValidationOptions,
): ExampleIssue[] {
    const resolve = (node: unknown, pointer: string): Clause => {
        const resolved = resolveObjectReference(node, document, cache, pointer);
        if (!resolved) throw new NativeExampleError(pointer, "Expected an example schema object");
        return { node: resolved.value, pointer: resolved.pointer };
    };
    const checkedCompositions = new Set<object>();
    const activeCompositions = new Set<object>();
    const checkCompositions = (entry: Clause): void => {
        const target = resolve(entry.node, entry.pointer);
        if (activeCompositions.has(target.node)) {
            throw new NativeExampleError(target.pointer, "Cyclic schema composition cannot be checked");
        }
        if (checkedCompositions.has(target.node)) return;
        activeCompositions.add(target.node);
        for (const keyword of ["allOf", "oneOf", "anyOf"]) {
            if (!hasOwnField(target.node, keyword)) continue;
            const branches = target.node[keyword];
            if (!Array.isArray(branches) || !branches.length) {
                throw new NativeExampleError(target.pointer, `Expected a non-empty ${keyword}`);
            }
            branches.forEach((branch: unknown, index: number) =>
                checkCompositions(resolve(branch, appendPointer(target.pointer, keyword, index))));
        }
        activeCompositions.delete(target.node);
        checkedCompositions.add(target.node);
    };
    const flatten = (input: readonly Clause[]): Clause[] => {
        const result: Clause[] = [];
        const seen = new Set<object>();
        const marks = new Map(input.map((entry) => [entry.node, entry]));
        const visit = (entry: Clause) => {
            const target = resolve(entry.node, entry.pointer);
            if (seen.has(target.node)) return;
            seen.add(target.node);
            result.push({
                ...target, skipOneOf: entry.skipOneOf || marks.get(target.node)?.skipOneOf,
                skipAnyOf: entry.skipAnyOf || marks.get(target.node)?.skipAnyOf,
            });
            if (hasOwnField(target.node, "allOf")) {
                const branches = target.node.allOf;
                if (!Array.isArray(branches) || !branches.length) throw new NativeExampleError(target.pointer, "Expected a non-empty allOf");
                branches.forEach((branch: unknown, index: number) => visit(resolve(branch, appendPointer(target.pointer, "allOf", index))));
            }
        };
        input.forEach(visit);
        return result;
    };
    const validate = (
        current: unknown, input: readonly Clause[], path: readonly (string | number)[], compositions = new Set<string>(),
    ): ExampleIssue[] => {
        input.forEach(checkCompositions);
        const clauses = flatten(input);
        for (let index = 0; index < clauses.length; index++) {
            const entry = clauses[index];
            for (const keyword of ["oneOf", "anyOf"] as const) {
                if (!hasOwnField(entry.node, keyword) || (keyword === "oneOf" ? entry.skipOneOf : entry.skipAnyOf)) continue;
                const branches = entry.node[keyword];
                if (!Array.isArray(branches) || !branches.length) throw new NativeExampleError(entry.pointer, `Expected a non-empty ${keyword}`);
                const key = `${entry.pointer}:${keyword}`;
                if (compositions.has(key)) throw new NativeExampleError(entry.pointer, "Cyclic schema composition cannot be checked");
                const nextCompositions = new Set(compositions).add(key);
                const base = clauses.map((clause) => clause.node === entry.node
                    ? { ...clause, ...(keyword === "oneOf" ? { skipOneOf: true } : { skipAnyOf: true }) } : clause);
                const matches = branches.filter((branch: unknown, branchIndex: number) =>
                    validate(current, [...base, resolve(branch, appendPointer(entry.pointer, keyword, branchIndex))], path, nextCompositions).length === 0
                ).length;
                const exact = keyword === "oneOf" && (options.checkTypes || options.checkRequired);
                if (exact ? matches === 1 : matches > 0) return [];
                return [{ code: "composition", path, detail: `Example must match ${keyword === "oneOf" ? "exactly one" : "at least one"} ${keyword} branch.` }];
            }
        }
        const issues: ExampleIssue[] = [];
        for (const { node, pointer } of clauses) {
            if (options.checkTypes) {
                const type = typeOfSchema(node, pointer);
                const matches = type === undefined || (current === null && node.nullable === true) ||
                    (type === "object" && isRecord(current)) || (type === "array" && Array.isArray(current)) ||
                    (type === "string" && typeof current === "string") || (type === "boolean" && typeof current === "boolean") ||
                    (type === "number" && typeof current === "number") || (type === "integer" && typeof current === "number" && Number.isInteger(current));
                if (type !== undefined && !["object", "array", "string", "boolean", "number", "integer"].includes(type)) {
                    throw new NativeExampleError(pointer, `Unsupported example schema type "${type}"`);
                }
                if (!matches) issues.push({ code: "type", path, detail: `Expected ${type}.` });
                if (node.enum !== undefined) {
                    if (!Array.isArray(node.enum)) throw new NativeExampleError(pointer, "Expected a schema enum array");
                    if (!node.enum.some((entry: unknown) => equalJson(entry, current))) {
                        issues.push({ code: "enum", path, detail: "Value is not one of the declared enum values." });
                    }
                }
            }
            if (options.checkRequired && isRecord(current) && node.required !== undefined) {
                if (!Array.isArray(node.required) || node.required.some((key: unknown) => typeof key !== "string")) {
                    throw new NativeExampleError(pointer, "Expected required field names");
                }
                for (const key of node.required) {
                    const property = isRecord(node.properties) ? node.properties[key] : undefined;
                    const target = property === undefined ? undefined : resolve(property, appendPointer(pointer, "properties", key)).node;
                    if ((options.direction === "request" && target?.readOnly === true) ||
                        (options.direction === "response" && target?.writeOnly === true)) continue;
                    if (!hasOwnField(current, key)) issues.push({ code: "required", path: [...path, key], detail: "Required field is missing." });
                }
            }
        }
        if (isRecord(current)) {
            for (const [key, child] of Object.entries(current)) {
                const children: Clause[] = [];
                let known = path.length === 0 && options.allowedRootProperties?.has(key) === true;
                let explicitlyAllowed = false;
                let explicitlyForbidden = false;
                for (const { node, pointer } of clauses) {
                    if (node.properties !== undefined && !isRecord(node.properties)) throw new NativeExampleError(pointer, "Expected schema properties");
                    if (isRecord(node.properties) && hasOwnField(node.properties, key)) {
                        known = true;
                        children.push(resolve(node.properties[key], appendPointer(pointer, "properties", key)));
                    } else if (isRecord(node.additionalProperties)) {
                        explicitlyAllowed = true;
                        children.push(resolve(node.additionalProperties, appendPointer(pointer, "additionalProperties")));
                    } else if (node.additionalProperties === true) {
                        explicitlyAllowed = true;
                    } else if (node.additionalProperties === false) {
                        explicitlyForbidden = true;
                    } else if (node.additionalProperties !== undefined) {
                        throw new NativeExampleError(pointer, "Expected additionalProperties boolean or schema");
                    }
                }
                if (options.forbidUndefined && (explicitlyForbidden || (!known && !explicitlyAllowed))) {
                    issues.push({ code: "undefined", path: [...path, key], detail: "Field is not defined in the schema." });
                }
                if (children.length) issues.push(...validate(child, children, [...path, key]));
            }
        } else if (Array.isArray(current)) {
            const items = clauses.filter((entry) => entry.node.items !== undefined)
                .map((entry) => resolve(entry.node.items, appendPointer(entry.pointer, "items")));
            if (items.length) current.forEach((item, index) => issues.push(...validate(item, items, [...path, index])));
        }
        return issues;
    };
    assertJsonExample(value, declaration.pointer);
    const issues = validate(value, [declaration], []);
    const seen = new Set<string>();
    return issues.filter((issue) => {
        const key = JSON.stringify([issue.code, issue.path, issue.detail]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function examplePath(path: readonly (string | number)[]): string {
    return path.map((token, index) => typeof token === "number" ? `[${token}]` : `${index ? "." : ""}${token}`).join("") || "$";
}
