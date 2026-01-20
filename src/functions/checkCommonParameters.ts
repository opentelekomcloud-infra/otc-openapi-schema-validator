import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { looksLikeAbbreviation, looksLikeUnknownWord, getAllowedAbbreviations } from "@/utils/englishWords";
import { findParameterPositionInYaml } from "@/utils/pos";
import { getSource } from "@/functions/common";

export function checkCommonParameters(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const reported = new Set<string>();

    const params = rule?.call?.functionParams ?? {};
    const methodsToCheck: string[] = Array.isArray(params.methods) ? params.methods : [];

    const allowedNameArr: string[] = Array.isArray(params.allowedName) ? params.allowedName : [];
    const notAllowedArr: string[] = Array.isArray(params.notAllowedNames) ? params.notAllowedNames : [];

    const allowedNames = new Set<string>(allowedNameArr.map((s) => String(s).trim().toLowerCase()));
    const notAllowedNames = new Set<string>(notAllowedArr.map((s) => String(s).trim().toLowerCase()));

    const allowedAbbrevs = getAllowedAbbreviations();

    function decodeJsonPointerToken(token: string): string {
        return token.replace(/~1/g, "/").replace(/~0/g, "~");
    }

    function resolveRef(obj: any): any {
        let curObj: any = obj;
        const seen = new Set<string>();

        while (curObj && typeof curObj === "object" && typeof curObj.$ref === "string") {
            const ref: string = curObj.$ref;
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
            curObj = resolved;
        }

        return curObj;
    }

    function splitIdentifierToTokens(name: string): string[] {
        const base = name
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .toLowerCase();
        return base.split(/\s+/).filter(Boolean);
    }

    function isSuspiciousName(name: string): { badTokens: string[]; reasons: string[] } {
        const badTokens: string[] = [];
        const reasons: string[] = [];

        const tokens = splitIdentifierToTokens(name);
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

        return { badTokens: Array.from(new Set(badTokens)), reasons: Array.from(new Set(reasons)) };
    }

    function pushDiagnosticAtRange(from: number, to: number, msg: string, dedupeKey: string) {
        const key = `${getSource(rule)}|${dedupeKey}`;
        if (reported.has(key)) return;
        reported.add(key);

        diagnostics.push({
            from,
            to,
            severity: mapSeverity(rule.severity),
            message: msg,
            source: getSource(rule),
        });
    }

    function findOperationAnchorIndex(pathKey: string, method: string): number {
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
        return methodIdx >= 0 ? methodIdx : searchFromPath;
    }

    function findKeyRangeInContent(key: string, searchStart?: number): { from: number; to: number } {
        const needles = [`\n${key}:`, `${key}:`, `\n\"${key}\":`, `\"${key}\":`];

        if (typeof searchStart === "number" && searchStart >= 0) {
            for (const n of needles) {
                const idx = content.indexOf(n, searchStart);
                if (idx >= 0) {
                    const start = idx + (n.startsWith("\n") ? 1 : 0) + (n.includes('"') ? 1 : 0);
                    return { from: start, to: start + key.length };
                }
            }
        }

        for (const n of needles) {
            const idx = content.indexOf(n);
            if (idx >= 0) {
                const start = idx + (n.startsWith("\n") ? 1 : 0) + (n.includes('"') ? 1 : 0);
                return { from: start, to: start + key.length };
            }
        }

        return { from: 0, to: 0 };
    }

    function evaluateName(nameRaw: string, range?: { from: number; to: number }, searchStart?: number, dedupeContext?: string) {
        const name = String(nameRaw).toLowerCase();
        if (!name) return;

        if (allowedNames.has(name)) {
            return;
        }

        if (notAllowedNames.has(name)) {
            const r = range ?? findKeyRangeInContent(nameRaw, searchStart);
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
            const r = range ?? findKeyRangeInContent(nameRaw, searchStart);
            pushDiagnosticAtRange(
                r.from,
                r.to,
                `Parameter/property name "${nameRaw}" may not follow common standard words (${suspicious.reasons.join(", ")}: ${suspicious.badTokens.join(", ")}). ${rule.message}`,
                `suspicious|${dedupeContext ?? ""}|${name}|${suspicious.badTokens.join("_")}`
            );
        }
    }

    function findRefUsageRangeInOperation(pathKey: string, method: string, ref: string): { from: number; to: number } {
        const pathNeedles = [`\n  ${pathKey}:`, `\n  "${pathKey}":`, `\n${pathKey}:`, `\n"${pathKey}":`];
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
        const searchFromMethod = methodIdx >= 0 ? methodIdx : searchFromPath;

        const idx = content.indexOf(ref, searchFromMethod);
        if (idx >= 0) {
            return { from: idx, to: idx + ref.length };
        }

        const refKeyIdx = content.indexOf("$ref", searchFromMethod);
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
            const resolved = resolveRef(p);
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
        seen = new Set<any>()
    ) {
        const s = resolveRef(schema);
        if (!s || typeof s !== "object") return;
        if (seen.has(s)) return;
        seen.add(s);

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

    function exampleWalk(example: any, visitor: (propName: string) => void, seen = new Set<any>()) {
        if (example === null || example === undefined) return;
        if (typeof example !== "object") return;
        if (seen.has(example)) return;
        seen.add(example);

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
            const rb = resolveRef(operation.requestBody);
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
                const r = resolveRef(resp);
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

        const opMethods = methodsToCheck.length ? methodsToCheck : Object.keys(pathItem);
        for (const method of opMethods) {
            const m = String(method).toLowerCase();
            const operation = pathItem[m];
            if (!operation || typeof operation !== "object") continue;

            collectParameterNamesForOperation(pathKey, m, operation);
            collectBodyAndResponseNames(pathKey, m, operation);
        }
    }

    return diagnostics;
}
