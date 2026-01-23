import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { looksLikeAbbreviation, looksLikeUnknownWord, getAllowedAbbreviations } from "@/utils/englishWords";
import {findKeyRangeInContent, findParameterPositionInYaml} from "@/utils/pos";
import { getSource } from "@/functions/common";
import { resolveRefDeep } from "@/utils/schema";

export function checkCommonParameters(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const source = getSource(rule);

    if (!spec?.paths) return diagnostics;

    const reported = new Set<string>();
    const opAnchorCache = new Map<string, number>();
    const refCache = new Map<string, any>();

    const HTTP_METHODS = new Set(["get", "put", "post", "patch", "delete", "head", "options", "trace"]);

    const params = rule?.call?.functionParams ?? {};
    const methodsToCheck: string[] = Array.isArray(params.methods)
        ? params.methods.map((m: any) => String(m).trim().toLowerCase()).filter(Boolean)
        : [];

    const allowedNameArr: string[] = Array.isArray(params.allowedName) ? params.allowedName : [];
    const notAllowedArr: string[] = Array.isArray(params.notAllowedNames) ? params.notAllowedNames : [];

    const allowedNames = new Set<string>(allowedNameArr.map((s) => String(s).trim().toLowerCase()));
    const notAllowedNames = new Set<string>(notAllowedArr.map((s) => String(s).trim().toLowerCase()));

    const allowedAbbrevs = getAllowedAbbreviations();
    const tokenCache = new Map<string, string[]>();
    const suspiciousCache = new Map<string, { badTokens: string[]; reasons: string[] }>();

    function splitIdentifierToTokens(name: string): string[] {
        const key = String(name);
        const cached = tokenCache.get(key);
        if (cached) return cached;

        const base = key
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .toLowerCase();

        const tokens = base.split(/\s+/).filter(Boolean);
        tokenCache.set(key, tokens);
        return tokens;
    }

    function isSuspiciousName(name: string): { badTokens: string[]; reasons: string[] } {
        const key = String(name);
        const cached = suspiciousCache.get(key);
        if (cached) return cached;

        const badTokens: string[] = [];
        const reasons: string[] = [];

        const tokens = splitIdentifierToTokens(key);
        for (const t of tokens) {
            if (looksLikeAbbreviation(t, allowedAbbrevs)) {
                badTokens.push(t);
                reasons.push("uncommon abbreviation");
                continue;
            }
            if (looksLikeUnknownWord(t)) {
                badTokens.push(t);
                reasons.push("non-dictionary term");
            }
        }

        const result = { badTokens: Array.from(new Set(badTokens)), reasons: Array.from(new Set(reasons)) };
        suspiciousCache.set(key, result);
        return result;
    }

    function pushDiagnosticAtRange(from: number, to: number, msg: string, dedupeKey: string) {
        const key = `${source}|${dedupeKey}`;
        if (reported.has(key)) return;
        reported.add(key);

        diagnostics.push({
            from,
            to,
            severity: mapSeverity(rule.severity),
            message: msg,
            source,
        });
    }

    function findOperationAnchorIndex(pathKey: string, method: string): number {
        const cacheKey = `${pathKey}#${method}`;
        const cached = opAnchorCache.get(cacheKey);
        if (typeof cached === "number") return cached;
        const pathNeedles = [`\n  ${pathKey}:`, `\n${pathKey}:`];
        let pathIdx = -1;
        for (const n of pathNeedles) {
            pathIdx = content.indexOf(n);
            if (pathIdx >= 0) break;
        }
        const searchFromPath = pathIdx >= 0 ? pathIdx : 0;

        const methodNeedles = [`\n    ${method}:`, `\n  ${method}:`];
        let methodIdx = -1;
        for (const n of methodNeedles) {
            methodIdx = content.indexOf(n, searchFromPath);
            if (methodIdx >= 0) break;
        }
        const anchor = methodIdx >= 0 ? methodIdx : searchFromPath;
        opAnchorCache.set(cacheKey, anchor);
        return anchor;
    }



    function evaluateName(nameRaw: string, range?: { from: number; to: number }, searchStart?: number, dedupeContext?: string) {
        const name = String(nameRaw).trim().toLowerCase();
        if (!name) return;

        if (allowedNames.has(name)) {
            return;
        }

        if (notAllowedNames.has(name)) {
            const r = range ?? findKeyRangeInContent(content, nameRaw, searchStart);
            pushDiagnosticAtRange(
                r.from,
                r.to,
                `Parameter/property name "${nameRaw}" is not allowed. ${rule.message}`,
                `notAllowed|${dedupeContext ?? ""}|${name}`
            );
            return;
        }

        const suspicious = isSuspiciousName(nameRaw);
        if (suspicious.badTokens.length) {
            const r = range ?? findKeyRangeInContent(content, nameRaw, searchStart);
            pushDiagnosticAtRange(
                r.from,
                r.to,
                `Parameter/property name "${nameRaw}" may not follow common standard words (${suspicious.reasons.join(", ")}: ${suspicious.badTokens.join(", ")}). ${rule.message}`,
                `suspicious|${dedupeContext ?? ""}|${name}|${suspicious.badTokens.join("_")}`
            );
        }
    }

    function findRefUsageRangeInOperation(pathKey: string, method: string, ref: string): { from: number; to: number } {
        // Reuse cached operation anchor to avoid repeated scanning.
        const opAnchor = findOperationAnchorIndex(pathKey, method);

        const idx = content.indexOf(ref, opAnchor);
        if (idx >= 0) {
            return { from: idx, to: idx + ref.length };
        }

        const refKeyIdx = content.indexOf("$ref", opAnchor);
        if (refKeyIdx >= 0) {
            return { from: refKeyIdx, to: refKeyIdx + 4 };
        }

        return { from: 0, to: 0 };
    }

    function collectParameterNamesForOperation(pathKey: string, method: string, operation: any) {
        const opParams: any[] = [];
        if (Array.isArray(spec.paths?.[pathKey]?.parameters)) opParams.push(...spec.paths[pathKey].parameters);
        if (Array.isArray(operation?.parameters)) opParams.push(...operation.parameters);

        const ctx = `${pathKey}#${method}`;
        const opAnchor = findOperationAnchorIndex(pathKey, method);

        for (const p of opParams) {
            const ref = typeof p?.$ref === "string" ? p.$ref : null;
            const resolved = resolveRefDeep(p, refCache, spec);
            const name = resolved?.name;
            if (typeof name !== "string") continue;

            if (ref) {
                const r = findRefUsageRangeInOperation(pathKey, method, ref);
                evaluateName(name, r.from || r.to ? { from: r.from, to: r.to } : undefined, opAnchor, ctx);
                continue;
            }

            try {
                const { start, end } = findParameterPositionInYaml(content, pathKey, method, name);
                evaluateName(name, { from: start, to: end }, opAnchor, ctx);
            } catch {
                evaluateName(name, undefined, opAnchor, ctx);
            }
        }
    }

    function schemaWalk(
        schema: any,
        visitor: (propName: string) => void,
        searchStart?: number,
        dedupeContext?: string,
        seen = new WeakSet<object>()
    ) {
        const s = resolveRefDeep(schema, refCache, spec);
        if (!s || typeof s !== "object") return;
        if (seen.has(s as object)) return;
        seen.add(s as object);

        if (s.allOf && Array.isArray(s.allOf)) {
            for (const sub of s.allOf) schemaWalk(sub, visitor, searchStart, dedupeContext, seen);
        }
        if (s.oneOf && Array.isArray(s.oneOf)) {
            for (const sub of s.oneOf) schemaWalk(sub, visitor, searchStart, dedupeContext, seen);
        }
        if (s.anyOf && Array.isArray(s.anyOf)) {
            for (const sub of s.anyOf) schemaWalk(sub, visitor, searchStart, dedupeContext, seen);
        }

        if (s.properties && typeof s.properties === "object") {
            for (const [k, v] of Object.entries(s.properties)) {
                visitor(k);
                schemaWalk(v, visitor, searchStart, dedupeContext, seen);
            }
        }

        if (s.items) {
            schemaWalk(s.items, visitor, searchStart, dedupeContext, seen);
        }

        // AdditionalProperties can also contain schema
        if (s.additionalProperties && typeof s.additionalProperties === "object") {
            schemaWalk(s.additionalProperties, visitor, searchStart, dedupeContext, seen);
        }
    }

    function exampleWalk(example: any, visitor: (propName: string) => void, seen = new WeakSet<object>()) {
        if (example === null || example === undefined) return;
        if (typeof example !== "object") return;
        if (seen.has(example as object)) return;
        seen.add(example as object);

        if (Array.isArray(example)) {
            for (const item of example) {
                exampleWalk(item, visitor, seen);
            }
            return;
        }

        for (const [k, v] of Object.entries(example)) {
            visitor(k);
            exampleWalk(v, visitor, seen);
        }
    }

    // Helper to find the schema usage (schema key or $ref) inside operation content
    function findSchemaUsageRangeInOperation(pathKey: string, method: string, schemaObj: any): { from: number; to: number } {
        const ref = typeof schemaObj?.$ref === "string" ? schemaObj.$ref : null;
        if (ref) {
            return findRefUsageRangeInOperation(pathKey, method, ref);
        }
        // Fallback: highlight the `schema` key near the method
        const anchor = findOperationAnchorIndex(pathKey, method);
        const idx = content.indexOf("schema:", anchor);
        if (idx >= 0) {
            return { from: idx, to: idx + "schema".length };
        }
        return { from: 0, to: 0 };
    }

    function collectBodyAndResponseNames(pathKey: string, method: string, operation: any) {
        const ctx = `${pathKey}#${method}`;
        const opAnchor = findOperationAnchorIndex(pathKey, method);

        // requestBody
        if (operation?.requestBody) {
            const rb = resolveRefDeep(operation.requestBody, refCache, spec);
            const contentObj = rb?.content;
            if (contentObj && typeof contentObj === "object") {
                for (const media of Object.values<any>(contentObj)) {
                    const schema = media?.schema;
                    if (schema) {
                        const schemaUsageRange = findSchemaUsageRangeInOperation(pathKey, method, schema);
                        schemaWalk(schema, (prop) => evaluateName(prop, schemaUsageRange, opAnchor, ctx), opAnchor, ctx);
                    }
                    // Also validate keys used in examples (if provided)
                    if (media?.example) {
                        exampleWalk(media.example, (k) => evaluateName(k, undefined, opAnchor, ctx));
                    }
                    if (media?.examples && typeof media.examples === "object") {
                        for (const ex of Object.values<any>(media.examples)) {
                            const val = ex?.value ?? ex;
                            exampleWalk(val, (k) => evaluateName(k, undefined, opAnchor, ctx));
                        }
                    }
                }
            }
        }

        // responses
        if (operation?.responses && typeof operation.responses === "object") {
            for (const [, resp] of Object.entries<any>(operation.responses)) {
                const r = resolveRefDeep(resp, refCache, spec);
                const contentObj = r?.content;
                if (contentObj && typeof contentObj === "object") {
                    for (const media of Object.values<any>(contentObj)) {
                        const schema = media?.schema;
                        if (schema) {
                            const schemaUsageRange = findSchemaUsageRangeInOperation(pathKey, method, schema);
                            schemaWalk(schema, (prop) => evaluateName(prop, schemaUsageRange, opAnchor, ctx), opAnchor, ctx);
                        }
                        // Also validate keys used in examples (if provided)
                        if (media?.example) {
                            exampleWalk(media.example, (k) => evaluateName(k, undefined, opAnchor, ctx));
                        }
                        if (media?.examples && typeof media.examples === "object") {
                            for (const ex of Object.values<any>(media.examples)) {
                                const val = ex?.value ?? ex;
                                exampleWalk(val, (k) => evaluateName(k, undefined, opAnchor, ctx));
                            }
                        }
                    }
                }
            }
        }
    }

    for (const pathKey of Object.keys(spec.paths)) {
        const pathItem = spec.paths[pathKey];
        if (!pathItem || typeof pathItem !== "object") continue;

        const opMethodsRaw = methodsToCheck.length ? methodsToCheck : Object.keys(pathItem);
        for (const method of opMethodsRaw) {
            const m = String(method).trim().toLowerCase();
            if (!HTTP_METHODS.has(m)) continue;

            const operation = pathItem[m];
            if (!operation || typeof operation !== "object") continue;

            collectParameterNamesForOperation(pathKey, m, operation);
            collectBodyAndResponseNames(pathKey, m, operation);
        }
    }

    return diagnostics;
}
