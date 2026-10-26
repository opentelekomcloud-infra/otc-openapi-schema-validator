import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Document } from "yaml";
import type { NativeOpenApiContext, SourceRange } from "@/types/openapi";
import { appendPointer, jsonPointer, NativeReferenceError, referenceTokens } from "./references";

export interface SourceLocation extends SourceRange {
    readonly pointer: string;
    readonly lineNumber: number;
    readonly fallback?: "missing" | "ambiguous" | "invalid-source" | "unresolved-reference";
}

export interface DuplicateMethodPath {
    readonly path: string;
    readonly location: SourceLocation;
    readonly methods: readonly { readonly method: string; readonly lines: readonly number[] }[];
}

interface SourceEntry {
    readonly node: unknown;
    readonly key?: unknown;
    readonly pointer: string;
}

interface Lookup {
    readonly entry: SourceEntry;
    readonly fallback?: SourceLocation["fallback"];
}

const lineIndexes = new Map<string, readonly number[]>();

export function sourceLineNumber(content: string, offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset > content.length) {
        throw new RangeError("Source offset is outside the original content.");
    }

    let starts = lineIndexes.get(content);
    if (!starts) {
        const lines = [0];
        for (let index = 0; index < content.length; index++) {
            if (content[index] === "\n" || (content[index] === "\r" && content[index + 1] !== "\n")) lines.push(index + 1);
        }
        starts = lines;
        lineIndexes.set(content, starts);
        if (lineIndexes.size > 2) lineIndexes.delete(lineIndexes.keys().next().value!);
    }
    let low = 0;
    let high = starts.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle] <= offset) low = middle + 1;
        else high = middle;
    }
    return low;
}

export function diagnosticLineNumber(
    content: string | undefined, diagnostic: { readonly from?: unknown; readonly lineNumber?: unknown } | null | undefined,
): number | "N/A" {
    const from = diagnostic?.from;
    if (typeof content === "string" && typeof from === "number" &&
        Number.isInteger(from) && from >= 0 && from <= content.length) {
        return sourceLineNumber(content, from);
    }
    const line = diagnostic?.lineNumber;
    if (typeof line === "number" && Number.isInteger(line) && line >= 1) {
        return line;
    }
    return "N/A";
}

export class OpenApiSourceMap {
    private readonly source: Document.Parsed;
    private readonly origins = new WeakMap<object, SourceEntry>();
    private readonly keys = new Map<string, SourceEntry[]>();
    private readonly children = new WeakMap<object, Map<string, Lookup>>();

    constructor(readonly content: string, source?: Document.Parsed) {
        // Project lone CR line endings to LF without changing any source offsets.
        this.source = source ?? parseDocument(content.replace(/\r(?!\n)/g, "\n"), {
            version: "1.2", merge: true, uniqueKeys: false, keepSourceTokens: true, prettyErrors: false,
        });
        const pending: SourceEntry[] = [{ node: this.source.contents, pointer: "#" }];
        while (pending.length) {
            const entry = pending.pop()!;
            if (!isNode(entry.node) || this.origins.has(entry.node)) continue;
            this.origins.set(entry.node, entry);
            if (isMap(entry.node)) {
                const children = new Map<string, Lookup>();
                for (const pair of entry.node.items) {
                    if (isScalar(pair.key) && typeof pair.key.value === "symbol" && pair.key.source === "<<") {
                        pending.push({ node: pair.value, key: pair.key, pointer: appendPointer(entry.pointer, "<<") });
                        continue;
                    }
                    if (!isScalar(pair.key) || !["string", "number"].includes(typeof pair.key.value)) continue;
                    const name = String(pair.key.value);
                    const child = { node: pair.value, key: pair.key, pointer: appendPointer(entry.pointer, name) };
                    const entries = this.keys.get(name) ?? [];
                    entries.push(child);
                    this.keys.set(name, entries);
                    children.set(name, children.has(name) ? { entry, fallback: "ambiguous" } : { entry: child });
                    pending.push(child);
                }
                this.children.set(entry.node, children);
            } else if (isSeq(entry.node)) {
                entry.node.items.forEach((node, index) => pending.push({ node, pointer: appendPointer(entry.pointer, index) }));
            }
        }
    }

    private origin(node: unknown, previous: SourceEntry): SourceEntry {
        return isNode(node) ? this.origins.get(node) ?? { node, pointer: previous.pointer } : previous;
    }

    private aliases(entry: SourceEntry): Lookup {
        const seen = new Set<object>();
        while (isAlias(entry.node)) {
            if (seen.has(entry.node)) return { entry, fallback: "unresolved-reference" };
            seen.add(entry.node);
            const target = entry.node.resolve(this.source);
            if (!target) return { entry, fallback: "unresolved-reference" };
            entry = this.origin(target, entry);
        }
        return { entry };
    }

    private child(entry: SourceEntry, token: string, active = new Set<object>()): Lookup {
        const unwrapped = this.aliases(entry);
        if (unwrapped.fallback) return unwrapped;
        entry = unwrapped.entry;
        const node = entry.node;
        if (isSeq(node)) {
            if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= node.items.length) return { entry, fallback: "missing" };
            const index = Number(token);
            if (!isNode(node.items[index])) return { entry, fallback: "missing" };
            return { entry: { node: node.items[index], pointer: appendPointer(entry.pointer, index) } };
        }
        if (!isMap(node)) return { entry, fallback: "missing" };
        if (active.has(node)) return { entry, fallback: "unresolved-reference" };
        const own = this.children.get(node)?.get(token);
        if (own) return own;
        const next = new Set(active).add(node);
        for (const pair of node.items) {
            if (!isScalar(pair.key) || typeof pair.key.value !== "symbol" || pair.key.source !== "<<") continue;
            const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
            for (const source of sources) {
                const result = this.child(this.origin(source, entry), token, next);
                if (result.fallback !== "missing") return result;
            }
        }
        return { entry, fallback: "missing" };
    }

    private lookup(pointer: string, followRefs: boolean): Lookup {
        const tokens = referenceTokens(pointer.startsWith("/") ? `#${pointer}` : pointer, pointer);
        let entry: SourceEntry = { node: this.source.contents, pointer: "#" };
        if (this.source.errors.length) return { entry, fallback: "invalid-source" };
        const dereference = (value: SourceEntry): Lookup => {
            const references = new Set<object>();
            while (true) {
                const aliases = this.aliases(value);
                if (aliases.fallback || !followRefs) return aliases;
                value = aliases.entry;
                if (!isMap(value.node)) return { entry: value };
                const reference = this.child(value, "$ref");
                if (reference.fallback === "missing") return { entry: value };
                if (reference.fallback) return reference;
                if (!isScalar(reference.entry.node)) return { entry: reference.entry, fallback: "unresolved-reference" };
                const ref = reference.entry.node.value;
                if (typeof ref !== "string" || !ref.startsWith("#") || references.has(value.node)) {
                    return { entry: reference.entry, fallback: "unresolved-reference" };
                }
                references.add(value.node);
                try {
                    const target = this.lookup(ref, false);
                    if (target.fallback) return { entry: reference.entry, fallback: "unresolved-reference" };
                    value = target.entry;
                } catch (error) {
                    if (!(error instanceof NativeReferenceError)) throw error;
                    return { entry: reference.entry, fallback: "unresolved-reference" };
                }
            }
        };
        for (const token of tokens) {
            const current = dereference(entry);
            if (current.fallback) return current;
            const result = this.child(current.entry, token);
            if (result.fallback) return result;
            entry = result.entry;
        }
        return dereference(entry);
    }

    locate(pointer: string, kind: "key" | "value" = "key", followRefs = false): SourceLocation {
        const result = this.lookup(pointer, followRefs);
        const valueRange = isNode(result.entry.node) ? result.entry.node.range : undefined;
        const preferKey = kind === "key" || result.fallback !== undefined || valueRange?.[0] === valueRange?.[1];
        const node = (preferKey && isNode(result.entry.key)) || !isNode(result.entry.node)
            ? result.entry.key : result.entry.node;
        const range = isNode(node) ? node.range : undefined;
        const from = range?.[0] ?? 0;
        const to = range?.[1] ?? from;
        if (from < 0 || to < from || to > this.content.length) throw new RangeError("AST range is outside the original content.");
        return { from, to, pointer: result.entry.pointer, lineNumber: sourceLineNumber(this.content, from), ...(result.fallback ? { fallback: result.fallback } : {}) };
    }

    scalar(pointer: string, followRefs = false): unknown {
        const result = this.lookup(pointer, followRefs);
        return !result.fallback && isScalar(result.entry.node) ? result.entry.node.value : undefined;
    }

    findKey(key: string, searchStart = 0): SourceLocation {
        const candidates = (this.keys.get(key) ?? []).filter((entry) =>
            isNode(entry.key) && (entry.key.range?.[0] ?? -1) >= searchStart);
        if (candidates.length === 1) return this.locate(candidates[0].pointer);
        return { ...this.locate("#"), fallback: candidates.length ? "ambiguous" : "missing" };
    }

    entries(pointer: string, followRefs = false): readonly { key: string; pointer: string }[] {
        const result = this.lookup(pointer, followRefs);
        if (result.fallback) return [];
        const { node } = result.entry;
        if (isSeq(node)) return node.items.map((_, index) => ({ key: String(index), pointer: appendPointer(result.entry.pointer, index) }));
        if (isMap(node)) return node.items.flatMap((pair) =>
            isScalar(pair.key) && ["string", "number"].includes(typeof pair.key.value)
                ? [{ key: String(pair.key.value), pointer: appendPointer(result.entry.pointer, String(pair.key.value)) }] : []);
        return [];
    }

    duplicateMethods(): readonly DuplicateMethodPath[] {
        if (this.source.errors.length) throw new Error("Cannot inspect duplicate HTTP methods: the source AST is invalid.");
        if (!isMap(this.source.contents)) return [];
        const result: DuplicateMethodPath[] = [];
        for (const rootPair of this.source.contents.items) {
            if (!isScalar(rootPair.key) || rootPair.key.value !== "paths") continue;
            const paths = this.aliases({ node: rootPair.value, key: rootPair.key, pointer: "#/paths" });
            if (paths.fallback) throw new Error("Cannot inspect duplicate HTTP methods: unresolved paths alias.");
            if (!isMap(paths.entry.node)) continue;
            for (const pathPair of paths.entry.node.items) {
                if (!isScalar(pathPair.key) || typeof pathPair.key.value !== "string" || !pathPair.key.value.startsWith("/")) continue;
                const path = pathPair.key.value;
                const pointer = appendPointer("#/paths", path);
                const pending: SourceEntry[] = [{ node: pathPair.value, key: pathPair.key, pointer }];
                const visited = new Set<object>();
                const duplicates = new Map<string, number[]>();
                while (pending.length) {
                    const current = this.aliases(pending.pop()!);
                    if (current.fallback) throw new Error(`Cannot inspect duplicate HTTP methods for "${path}": unresolved Path Item alias.`);
                    const { entry } = current;
                    if (!isMap(entry.node) || visited.has(entry.node)) continue;
                    visited.add(entry.node);
                    // Overrides across merge sources are not repeated keys within one mapping.
                    const declarations = new Map<string, number[]>();
                    const reference = entry.node.items.findLast((pair) => isScalar(pair.key) && pair.key.value === "$ref");
                    for (const pair of entry.node.items) {
                        if (!isScalar(pair.key)) continue;
                        if (typeof pair.key.value === "symbol" && pair.key.source === "<<") {
                            const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
                            for (const source of sources) pending.push(this.origin(source, entry));
                        } else if (pair === reference) {
                            const ref = isScalar(pair.value) ? pair.value.value : undefined;
                            if (typeof ref !== "string") {
                                throw new NativeReferenceError("INVALID_REFERENCE", ref, entry.pointer, "Expected a Path Item reference string");
                            }
                            referenceTokens(ref, entry.pointer);
                            const target = this.lookup(ref, true);
                            if (target.fallback) {
                                throw new NativeReferenceError(
                                    "UNRESOLVED_REFERENCE", ref,
                                    entry.pointer, "Cannot inspect duplicate HTTP methods through this Path Item reference",
                                );
                            }
                            pending.push(target.entry);
                        } else if (typeof pair.key.value === "string" && /^(get|put|post|delete|options|head|patch|trace)$/.test(pair.key.value)) {
                            if (!pair.key.range) throw new Error("HTTP method declaration has no source range.");
                            const lines = declarations.get(pair.key.value) ?? [];
                            lines.push(sourceLineNumber(this.content, pair.key.range[0]));
                            declarations.set(pair.key.value, lines);
                        }
                    }
                    for (const [method, lines] of declarations) {
                        if (lines.length > 1) duplicates.set(method, [...(duplicates.get(method) ?? []), ...lines]);
                    }
                }
                if (!duplicates.size) continue;
                if (!pathPair.key.range) throw new Error("Path declaration has no source range.");
                result.push({
                    path,
                    location: {
                        from: pathPair.key.range[0], to: pathPair.key.range[1], pointer,
                        lineNumber: sourceLineNumber(this.content, pathPair.key.range[0]),
                    },
                    methods: [...duplicates].map(([method, lines]) => ({ method, lines: lines.sort((a, b) => a - b) }))
                        .sort((a, b) => a.lines[0] - b.lines[0]),
                });
            }
        }
        return result;
    }

    parameter(path: string, method: string, name: string, location?: string): SourceLocation {
        const pathPointer = jsonPointer(["paths", path]);
        const operation = appendPointer(pathPointer, method);
        for (const parent of [operation, pathPointer]) {
            for (const item of this.entries(appendPointer(parent, "parameters"), true)) {
                if (this.scalar(appendPointer(item.pointer, "name"), true) !== name) continue;
                if (location !== undefined && this.scalar(appendPointer(item.pointer, "in"), true) !== location) continue;
                return this.locate(appendPointer(item.pointer, "name"), "value", true);
            }
        }
        return { ...this.locate(operation, "key", true), fallback: "missing" };
    }

    requestBody(path: string, method: string): SourceLocation {
        const operation = jsonPointer(["paths", path, method]);
        if (this.scalar("#/swagger") === "2.0" || this.scalar("#/swagger") === 2) {
            for (const parent of [operation, jsonPointer(["paths", path])]) {
                for (const item of this.entries(appendPointer(parent, "parameters"), true)) {
                    if (this.scalar(appendPointer(item.pointer, "in"), true) === "body") return this.locate(item.pointer, "value", true);
                }
            }
            return { ...this.locate(operation, "key", true), fallback: "missing" };
        }
        return this.locate(appendPointer(operation, "requestBody"), "key", true);
    }
}

const recent = new Map<string, OpenApiSourceMap>();

export function sourceMap(content: string): OpenApiSourceMap {
    const previous = recent.get(content);
    if (previous) return previous;
    const result = new OpenApiSourceMap(content);
    recent.set(content, result);
    if (recent.size > 2) recent.delete(recent.keys().next().value!);
    return result;
}

export function nativeSourceMap(context: NativeOpenApiContext): OpenApiSourceMap {
    return new OpenApiSourceMap(context.originalContent, context.sourceDocument);
}

export function operationRange(content: string, path: string, method: string): SourceLocation {
    return sourceMap(content).locate(jsonPointer(["paths", path, method]), "key", true);
}

export function pathRange(content: string, path: string): SourceLocation {
    return sourceMap(content).locate(jsonPointer(["paths", path]));
}

const documentIndexes = new WeakMap<object, { content: string; pointers: WeakMap<object, string> }>();

export function objectRange(
    document: unknown, content: string, node: unknown, property?: string, kind: "key" | "value" = "key",
): SourceLocation {
    const source = sourceMap(content);
    if (document === null || typeof document !== "object" || node === null || typeof node !== "object") {
        return { ...source.locate("#"), fallback: "missing" };
    }
    let index = documentIndexes.get(document);
    if (!index || index.content !== content) {
        index = { content, pointers: new WeakMap() };
        const pending: { node: object; pointer: string }[] = [{ node: document, pointer: "#" }];
        while (pending.length) {
            const entry = pending.pop()!;
            if (index.pointers.has(entry.node)) continue;
            index.pointers.set(entry.node, entry.pointer);
            const entries = entry.node instanceof Map
                ? Array.from(entry.node.entries(), ([key, value]) => [String(key), value] as const)
                : Object.entries(entry.node);
            for (const [key, value] of entries) {
                if (value !== null && typeof value === "object") pending.push({ node: value, pointer: appendPointer(entry.pointer, key) });
            }
        }
        documentIndexes.set(document, index);
    }
    const pointer = index.pointers.get(node);
    if (pointer === undefined) return { ...source.locate("#"), fallback: "missing" };
    return source.locate(property === undefined ? pointer : appendPointer(pointer, property), kind);
}
