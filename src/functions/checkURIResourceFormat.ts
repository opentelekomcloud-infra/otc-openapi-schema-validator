import { pathRange } from "@/lib/openapi/sourceMap";
import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { isRulePathExcluded, ruleOperations, ruleStrings } from "@/utils/nativeRule";
import { namingSchemas, rootSchemaFields } from "@/utils/nativeNaming";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";
import { resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import type { NativeOperation } from "@/types/openapi";

export function checkURIResourceFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const params = rule?.call?.functionParams ?? rule?.functionParams ?? {};
    const exceptionPaths = ruleStrings(params.exceptionPaths, "exceptionPaths");
    const ignoredWrappers = new Set(ruleStrings(params.ignoreWrapperNames ??
        ["request_id", "page_info", "total_count", "count", "metadata"], "ignoreWrapperNames").map((name) => name.toLowerCase()));
    const cache: ReferenceCache = new Map();

    // Common non-crud action/verb segments that may appear at the end of a URI
    const verbLikeTailArr: string[] = Array.isArray(params?.verbLikeTail) ? params.verbLikeTail : [];
    const verbLikeTail = new Set<string>(verbLikeTailArr.map((s) => String(s).toLowerCase()));

    // Words that end with 's' but are commonly singular in APIs
    const endsWithSButSingularArr: string[] = Array.isArray(params?.endsWithSButSingular) ? params.endsWithSButSingular : [];
    const endsWithSButSingular = new Set<string>(endsWithSButSingularArr.map((s) => String(s).toLowerCase()));

    const exceptionNote: string = params?.exception ?? "";

    const versionRegex = /^v[0-9]+(\.[0-9]+)?$/;
    const pathParamRegex = /^\{[a-z0-9_]+\}$/;

    function isPluralResource(seg: string): boolean {
        const s = seg.toLowerCase();
        if (endsWithSButSingular.has(s)) return false;
        return s.endsWith("s");
    }

    function isVerbTail(seg: string, method: string): boolean {
        const s = seg.toLowerCase();
        if (verbLikeTail.has(s) || s.split(/[-_]+/).some(word => verbLikeTail.has(word))) return true;
        return ["post", "put", "patch"].includes(method.toLowerCase()) && !isPluralResource(s);
    }

    function findLeafResourceSegment(pathKey: string, method: string): { segment: string | null; reason: string } {
        const segments = pathKey.split("/").filter(Boolean);
        const filtered: string[] = [];

        // Remove version segment and keep others in order
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (i === 0 && versionRegex.test(seg)) continue;
            filtered.push(seg);
        }

        if (filtered.length === 0) return { segment: null, reason: "empty" };

        // If the last segment is a param, leaf resource is the previous non-param segment
        let idx = filtered.length - 1;
        if (pathParamRegex.test(filtered[idx])) {
            idx -= 1;
        }

        if (idx < 0) return { segment: null, reason: "no-resource" };

        // If tail is verb-like, step back one more (but still skip params)
        if (!pathParamRegex.test(filtered[idx]) && isVerbTail(filtered[idx], method)) {
            idx -= 1;
            while (idx >= 0 && pathParamRegex.test(filtered[idx])) idx -= 1;
        }

        if (idx < 0) return { segment: null, reason: "no-resource" };

        // If still pointing at a param (edge-case), step back
        while (idx >= 0 && pathParamRegex.test(filtered[idx])) idx -= 1;
        if (idx < 0) return { segment: null, reason: "no-resource" };

        return { segment: filtered[idx], reason: "ok" };
    }

    function singletonEvidence(op: NativeOperation): { singleton: boolean; reason?: string } | undefined {
        const schemas = responseStatuses(op).filter((code) => /^2\d\d$/.test(code))
            .flatMap((code) => namingSchemas(responseFor(op, code, spec, cache), spec, cache).map((schema) => ({ code, schema })));
        if (!schemas.length) return undefined;
        for (const { code, schema } of schemas) {
            const node = schema.node;
            if (node.type === "array") {
                return { singleton: false, reason: `Response for status '${code}' returns an array, so it is a collection, not a singleton.` };
            }
            if (node.type !== undefined && node.type !== "object") return { singleton: false };
            if (node.items !== undefined || ["allOf", "oneOf", "anyOf"].some((key) => node[key] !== undefined)) return { singleton: false };
            const fields = rootSchemaFields(schema, spec, cache)
                .filter((field) => !ignoredWrappers.has(field.name.toLowerCase()));
            if (!fields.length) return { singleton: false };
            for (const field of fields) {
                const resolved = resolveObjectReference(field.node, spec, cache, field.pointer);
                if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", field.pointer, "Expected a schema object");
                const value = resolved.value;
                if (value.type === "array") {
                    return { singleton: false, reason: `Response for status '${code}' returns an array in root field '${field.name}', so it is a collection, not a singleton.` };
                }
                if (value.items !== undefined || ["allOf", "oneOf", "anyOf"].some((key) => value[key] !== undefined)) return { singleton: false };
                const singleField = value.type === "object" || value.properties !== undefined
                    ? !isPluralResource(field.name) : ["string", "number", "integer", "boolean"].includes(String(value.type));
                if (!singleField) return { singleton: false };
            }
        }
        return { singleton: true };
    }

    const operations = ruleOperations(spec,
        { methods: ["get", "post", "put", "patch", "delete"] }, (path) => !isRulePathExcluded(path, exceptionPaths));
    const queries = new Map(operations.filter((op) => op.method === "get").map((op) => [op.path, op]));
    for (const op of operations) {
        const { path: pathKey, method } = op;
        const leaf = findLeafResourceSegment(pathKey, method);
        if (!leaf.segment) continue;

        if (pathParamRegex.test(leaf.segment)) continue;

        if (!isPluralResource(leaf.segment)) {
            let responseReason = "";
            if (params.detectSingletonByResponse !== false && pathKey.split("/").filter(Boolean).at(-1) === leaf.segment) {
                const ownEvidence = singletonEvidence(op);
                const query = queries.get(pathKey);
                const evidence = ownEvidence ?? (query && query !== op ? singletonEvidence(query) : undefined);
                if (evidence?.singleton) continue;
                responseReason = evidence?.reason ? ` ${evidence.reason}` : "";
            }
            const range = pathRange(content, pathKey);
            const extra = exceptionNote ? ` Exception: ${exceptionNote}` : "";
            diagnostics.push({
                from: range.from,
                to: range.to,
                severity: mapSeverity(rule.severity),
                message: `Resource segment "${leaf.segment}" in path "${pathKey}" should be plural for CRUD operations.${responseReason}${extra}`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
