export type ReferenceCache = Map<string, unknown>;

export type ReferenceErrorCode =
    | "INVALID_REFERENCE"
    | "EXTERNAL_REFERENCE"
    | "UNRESOLVED_REFERENCE"
    | "CIRCULAR_REFERENCE"
    | "INVALID_REFERENCE_TARGET";

export class NativeReferenceError extends Error {
    constructor(
        readonly code: ReferenceErrorCode,
        readonly reference: unknown,
        readonly pointer: string,
        detail: string,
        options?: ErrorOptions,
    ) {
        const label = typeof reference === "string" ? reference : `<${reference === null ? "null" : typeof reference}>`;
        super(`${detail} at ${pointer}: ${label}`, options);
        this.name = "NativeReferenceError";
    }
}

export interface ResolvedReference {
    readonly value: unknown;
    readonly pointer: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map);
}

function hasOwn(value: unknown, key: string): boolean {
    return value instanceof Map ? value.has(key)
        : value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function readOwn(value: unknown, key: string): unknown {
    if (!hasOwn(value, key)) return undefined;
    if (value instanceof Map) return value.get(key);
    return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

export function jsonPointer(tokens: readonly (string | number)[]): string {
    return "#" + tokens.map((token) =>
        "/" + encodeURIComponent(String(token).replace(/~/g, "~0").replace(/\//g, "~1"))
    ).join("");
}

export function appendPointer(pointer: string, ...tokens: readonly (string | number)[]): string {
    return pointer + jsonPointer(tokens).slice(1);
}

function referenceTokens(reference: unknown, pointer: string): string[] {
    if (typeof reference !== "string" || reference.length === 0) {
        throw new NativeReferenceError("INVALID_REFERENCE", reference, pointer, "Expected a non-empty $ref string");
    }
    if (!reference.startsWith("#")) {
        throw new NativeReferenceError("EXTERNAL_REFERENCE", reference, pointer, "External references are unsupported");
    }
    let fragment: string;
    try {
        fragment = decodeURIComponent(reference.slice(1));
    } catch (cause) {
        throw new NativeReferenceError("INVALID_REFERENCE", reference, pointer, "Invalid URI fragment", { cause });
    }
    if (fragment === "") return [];
    if (!fragment.startsWith("/") || /~(?:[^01]|$)/.test(fragment)) {
        throw new NativeReferenceError("INVALID_REFERENCE", reference, pointer, "Expected an RFC6901 JSON Pointer");
    }
    return fragment.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

// A legacy Map is a cache scope token, not a source of unscoped/pre-populated targets.
const scopedCaches = new WeakMap<object, WeakMap<ReferenceCache, Map<string, ResolvedReference>>>();

function cacheFor(document: unknown, cache: ReferenceCache): Map<string, ResolvedReference> {
    if (document === null || typeof document !== "object") {
        throw new NativeReferenceError("INVALID_REFERENCE_TARGET", document, "#", "Expected a document object");
    }
    let scopes = scopedCaches.get(document);
    if (!scopes) {
        scopes = new WeakMap();
        scopedCaches.set(document, scopes);
    }
    let entries = scopes.get(cache);
    if (!entries) {
        entries = new Map();
        scopes.set(cache, entries);
    }
    return entries;
}

export function resolveReferenceNode(
    value: unknown,
    document: unknown,
    cache: ReferenceCache = new Map(),
    pointer = "#",
    siblingPolicy: "ignore" | "reject" = "ignore",
): ResolvedReference {
    let current = value;
    let currentPointer = pointer;
    const seen = new Set<string>();
    const traversed: string[] = [];
    let entries: Map<string, ResolvedReference> | undefined;

    while (hasOwn(current, "$ref")) {
        const reference = readOwn(current, "$ref");
        if (siblingPolicy === "reject" && isRecord(current) &&
            Object.keys(current).some((key) => key !== "$ref" && !key.startsWith("x-"))) {
            throw new NativeReferenceError(
                "INVALID_REFERENCE", reference, currentPointer, "Reference siblings require an explicit merge policy",
            );
        }
        const tokens = referenceTokens(reference, appendPointer(currentPointer, "$ref"));
        const targetPointer = jsonPointer(tokens);
        if (seen.has(targetPointer)) {
            throw new NativeReferenceError(
                "CIRCULAR_REFERENCE", reference, currentPointer, "Circular $ref alias chain",
            );
        }
        seen.add(targetPointer);
        const cacheKey = `${siblingPolicy}:${targetPointer}`;
        traversed.push(cacheKey);
        entries ??= cacheFor(document, cache);
        const cached = entries.get(cacheKey);
        if (cached) {
            current = cached.value;
            currentPointer = cached.pointer;
            break;
        }

        current = document;
        for (const token of tokens) {
            const validArrayIndex = !Array.isArray(current) || /^(0|[1-9]\d*)$/.test(token);
            if (!validArrayIndex || !hasOwn(current, token)) {
                throw new NativeReferenceError(
                    "UNRESOLVED_REFERENCE", reference, currentPointer, "Local reference does not exist",
                );
            }
            current = readOwn(current, token);
        }
        if (current === undefined) {
            throw new NativeReferenceError(
                "UNRESOLVED_REFERENCE", reference, currentPointer, "Local reference has an undefined target",
            );
        }
        currentPointer = targetPointer;
    }

    const resolved = { value: current, pointer: currentPointer };
    for (const reference of traversed) entries?.set(reference, resolved);
    return resolved;
}

export function resolveReference(
    reference: string, document: unknown, cache?: ReferenceCache,
): ResolvedReference {
    return resolveReferenceNode({ $ref: reference }, document, cache);
}

export function resolveObjectReference(
    value: unknown, document: unknown, cache?: ReferenceCache, pointer = "#",
    siblingPolicy: "ignore" | "reject" = "ignore",
): { readonly value: Record<string, unknown>; readonly pointer: string } | undefined {
    const resolved = resolveReferenceNode(value, document, cache, pointer, siblingPolicy);
    if (isRecord(resolved.value)) return { value: resolved.value, pointer: resolved.pointer };
    if (hasOwn(value, "$ref")) {
        throw new NativeReferenceError(
            "INVALID_REFERENCE_TARGET", readOwn(value, "$ref"), pointer, "Expected an object reference target",
        );
    }
    return undefined;
}
