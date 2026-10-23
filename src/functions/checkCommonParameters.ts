import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { looksLikeAbbreviation, looksLikeUnknownWord, getAllowedAbbreviations } from "@/utils/englishWords";
import { objectRange } from "@/lib/openapi/sourceMap";
import type { SourceRange } from "@/types/openapi";
import { getSource } from "@/functions/common";
import { resolveRefDeep } from "@/utils/schema";

export function checkCommonParameters(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const source = getSource(rule);

    if (!spec?.paths) return diagnostics;

    const reported = new Set<string>();
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

    function evaluateName(nameRaw: string, range: SourceRange, dedupeContext?: string) {
        const name = String(nameRaw).trim().toLowerCase();
        if (!name) return;

        if (allowedNames.has(name)) {
            return;
        }

        if (notAllowedNames.has(name)) {
            const r = range;
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
            const r = range;
            pushDiagnosticAtRange(
                r.from,
                r.to,
                `Parameter/property name "${nameRaw}" may not follow common standard words (${suspicious.reasons.join(", ")}: ${suspicious.badTokens.join(", ")}). ${rule.message}`,
                `suspicious|${dedupeContext ?? ""}|${name}|${suspicious.badTokens.join("_")}`
            );
        }
    }

    function collectParameterNamesForOperation(pathKey: string, method: string, operation: any) {
        const opParams: any[] = [];
        if (Array.isArray(spec.paths?.[pathKey]?.parameters)) opParams.push(...spec.paths[pathKey].parameters);
        if (Array.isArray(operation?.parameters)) opParams.push(...operation.parameters);

        const ctx = `${pathKey}#${method}`;
        for (const p of opParams) {
            const resolved = resolveRefDeep(p, refCache, spec);
            const name = resolved?.name;
            if (typeof name !== "string") continue;

            evaluateName(name, objectRange(spec, content, resolved, "name", "value"), ctx);
        }
    }

    function schemaWalk(
        schema: any,
        visitor: (propName: string, owner: object) => void,
        seen = new WeakSet<object>()
    ) {
        const s = resolveRefDeep(schema, refCache, spec);
        if (!s || typeof s !== "object") return;
        if (seen.has(s as object)) return;
        seen.add(s as object);

        if (s.allOf && Array.isArray(s.allOf)) {
            for (const sub of s.allOf) schemaWalk(sub, visitor, seen);
        }
        if (s.oneOf && Array.isArray(s.oneOf)) {
            for (const sub of s.oneOf) schemaWalk(sub, visitor, seen);
        }
        if (s.anyOf && Array.isArray(s.anyOf)) {
            for (const sub of s.anyOf) schemaWalk(sub, visitor, seen);
        }

        if (s.properties && typeof s.properties === "object") {
            for (const [k, v] of Object.entries(s.properties)) {
                visitor(k, s.properties);
                schemaWalk(v, visitor, seen);
            }
        }

        if (s.items) {
            schemaWalk(s.items, visitor, seen);
        }

        // AdditionalProperties can also contain schema
        if (s.additionalProperties && typeof s.additionalProperties === "object") {
            schemaWalk(s.additionalProperties, visitor, seen);
        }
    }

    function exampleWalk(example: any, visitor: (propName: string, owner: object) => void, seen = new WeakSet<object>()) {
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
            visitor(k, example);
            exampleWalk(v, visitor, seen);
        }
    }

    function collectBodyAndResponseNames(pathKey: string, method: string, operation: any) {
        const ctx = `${pathKey}#${method}`;

        // requestBody
        if (operation?.requestBody) {
            const rb = resolveRefDeep(operation.requestBody, refCache, spec);
            const contentObj = rb?.content;
            if (contentObj && typeof contentObj === "object") {
                for (const media of Object.values<any>(contentObj)) {
                    const schema = media?.schema;
                    if (schema) {
                        schemaWalk(schema, (prop, owner) => evaluateName(prop, objectRange(spec, content, owner, prop), ctx));
                    }
                    // Also validate keys used in examples (if provided)
                    if (media?.example) {
                        exampleWalk(media.example, (k, owner) => evaluateName(k, objectRange(spec, content, owner, k), ctx));
                    }
                    if (media?.examples && typeof media.examples === "object") {
                        for (const ex of Object.values<any>(media.examples)) {
                            const val = ex?.value ?? ex;
                            exampleWalk(val, (k, owner) => evaluateName(k, objectRange(spec, content, owner, k), ctx));
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
                            schemaWalk(schema, (prop, owner) => evaluateName(prop, objectRange(spec, content, owner, prop), ctx));
                        }
                        // Also validate keys used in examples (if provided)
                        if (media?.example) {
                            exampleWalk(media.example, (k, owner) => evaluateName(k, objectRange(spec, content, owner, k), ctx));
                        }
                        if (media?.examples && typeof media.examples === "object") {
                            for (const ex of Object.values<any>(media.examples)) {
                                const val = ex?.value ?? ex;
                                exampleWalk(val, (k, owner) => evaluateName(k, objectRange(spec, content, owner, k), ctx));
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
