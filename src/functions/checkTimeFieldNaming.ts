import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import {findKeyRangeInContent, findParameterPositionInYaml} from "@/utils/pos";
import { resolveRefDeep } from "@/utils/schema";

export function checkTimeFieldNaming(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec) return diagnostics;

    const source = getSource(rule);
    const params = rule?.call?.functionParams ?? {};
    const reported = new Set<string>();

    const recommendedArr: string[] = Array.isArray(params.recommendedNames) ? params.recommendedNames : [];
    const notRecommendedArr: string[] = Array.isArray(params.notRecommendedNames) ? params.notRecommendedNames : [];

    const recommended = new Set<string>(recommendedArr.map((s) => String(s).trim()));
    const notRecommended = new Set<string>(notRecommendedArr.map((s) => String(s).trim()));

    // Direct suggestion map for common variants.
    const suggestionMap = new Map<string, string>([
        ["created", "created_at"],
        ["updated", "updated_at"],
        ["deleted", "deleted_at"],
        ["expired", "expired_at"],
        ["createdAt", "created_at"],
        ["updatedAt", "updated_at"],
        ["create_time", "created_at"],
        ["update_time", "updated_at"],
        ["delete_time", "deleted_at"],
        ["expire_time", "expired_at"],
        ["begin_time", "start_time"],
    ]);

    const timeCandidateRe = /(?:^|[_-])(time|timestamp)(?:$|[_-])|(?:^|[_-])(created|updated|deleted|expired|expire)(?:$|[_-])|(?:_at$)/i;

    // CamelCase variants like createdAt/updatedAt. Case-sensitive to avoid matching words like "Format".
    const camelCaseAtRe = /[a-z]At$/;

    const startEndReadWithTimeRe = /(?:^|[_-])(start|end|read)(?:$|[_-]).*(?:^|[_-])(time|timestamp)(?:$|[_-])/i;

    // Ref resolution caches
    const refCache = new Map<string, any>();
    const visitedSchemas = new WeakSet<object>();

    function push(from: number, to: number, name: string, suggestion?: string) {
        // Deduplicate identical findings (common with shared schemas referenced in many places)
        const msg = suggestion
            ? `${rule.message} Found "${name}". Recommended: "${suggestion}".`
            : `${rule.message} Found "${name}".`;
        const dedupeKey = `${source}|${name}|${from}|${to}|${msg}`;
        if (reported.has(dedupeKey)) return;
        reported.add(dedupeKey);

        diagnostics.push({
            from,
            to,
            severity: mapSeverity(rule.severity),
            message: msg,
            source,
        });
    }

    function shouldEvaluate(name: string): boolean {
        if (!name) return false;
        if (recommended.has(name)) return false;
        if (notRecommended.has(name)) return true;

        const n = String(name);

        if (/^x-/i.test(n) && n.includes("-")) {
            return /(time|timestamp)/i.test(n) || /(_at$)/i.test(n) || camelCaseAtRe.test(n);
        }

        if (startEndReadWithTimeRe.test(n)) return true;
        return timeCandidateRe.test(n) || camelCaseAtRe.test(n);
    }

    function evaluateName(nameRaw: string, range?: { from: number; to: number }, searchStart?: number) {
        const name = String(nameRaw).trim();
        if (!shouldEvaluate(name)) return;

        // Explicitly not recommended
        if (notRecommended.has(name)) {
            const suggestion = suggestionMap.get(name);
            const r = range ?? findKeyRangeInContent(content, name, searchStart);
            push(r.from, r.to, name, suggestion);
            return;
        }

        // If it looks time-related but isn't recommended, warn (best-effort).
        // Keep recommended allow-list to prevent noise on known-good names.
        if (!recommended.has(name)) {
            const suggestion = suggestionMap.get(name);
            const r = range ?? findKeyRangeInContent(content, name, searchStart);
            push(r.from, r.to, name, suggestion);
        }
    }

    // Walk schemas and validate property keys
    function schemaWalk(schema: any, searchStart?: number, seen = visitedSchemas) {
        const s = resolveRefDeep(schema, refCache, spec);
        if (!s || typeof s !== "object") return;
        if (seen.has(s as object)) return;
        seen.add(s as object);

        if (s.allOf && Array.isArray(s.allOf)) for (const sub of s.allOf) schemaWalk(sub, searchStart, seen);
        if (s.oneOf && Array.isArray(s.oneOf)) for (const sub of s.oneOf) schemaWalk(sub, searchStart, seen);
        if (s.anyOf && Array.isArray(s.anyOf)) for (const sub of s.anyOf) schemaWalk(sub, searchStart, seen);

        if (s.properties && typeof s.properties === "object") {
            for (const [k, v] of Object.entries<any>(s.properties)) {
                evaluateName(k, undefined, searchStart);
                schemaWalk(v, searchStart, seen);
            }
        }

        if (s.items) schemaWalk(s.items, searchStart, seen);
        if (s.additionalProperties && typeof s.additionalProperties === "object") schemaWalk(s.additionalProperties, searchStart, seen);
    }

    // Scan operations: parameters + request/response schemas.
    if (spec.paths && typeof spec.paths === "object") {
        for (const pathKey of Object.keys(spec.paths)) {
            const pathItem = spec.paths[pathKey];
            if (!pathItem || typeof pathItem !== "object") continue;

            for (const method of Object.keys(pathItem)) {
                const m = String(method).trim().toLowerCase();
                // Only HTTP methods
                if (!pathItem[m] || typeof pathItem[m] !== "object") continue;
                if (!/[a-z]+/.test(m)) continue;

                const operation = pathItem[m];

                // parameters (path-level + op-level)
                const allParams: any[] = [];
                if (Array.isArray(pathItem.parameters)) allParams.push(...pathItem.parameters);
                if (Array.isArray(operation.parameters)) allParams.push(...operation.parameters);

                for (const p of allParams) {
                    const resolved = resolveRefDeep(p, refCache, spec);
                    const name = resolved?.name;
                    if (typeof name !== "string") continue;

                    try {
                        const { start, end } = findParameterPositionInYaml(content, pathKey, m, name);
                        evaluateName(name, { from: start, to: end });
                    } catch {
                        evaluateName(name);
                    }
                }

                // requestBody schemas
                if (operation.requestBody) {
                    const rb = resolveRefDeep(operation.requestBody, refCache, spec);
                    const contentObj = rb?.content;
                    if (contentObj && typeof contentObj === "object") {
                        for (const media of Object.values<any>(contentObj)) {
                            if (media?.schema) schemaWalk(media.schema);
                        }
                    }
                }

                // response schemas
                if (operation.responses && typeof operation.responses === "object") {
                    for (const resp of Object.values<any>(operation.responses)) {
                        const r = resolveRefDeep(resp, refCache, spec);
                        const contentObj = r?.content;
                        if (contentObj && typeof contentObj === "object") {
                            for (const media of Object.values<any>(contentObj)) {
                                if (media?.schema) schemaWalk(media.schema);
                            }
                        }
                    }
                }
            }
        }
    }

    // Global scan of components.schemas (location: all)
    if (spec.components?.schemas && typeof spec.components.schemas === "object") {
        for (const schemaDef of Object.values<any>(spec.components.schemas)) {
            schemaWalk(schemaDef);
        }
    }

    return diagnostics;
}
