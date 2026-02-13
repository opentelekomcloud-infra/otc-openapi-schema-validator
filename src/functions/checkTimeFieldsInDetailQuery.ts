import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { resolveRefDeep } from "@/utils/schema";
import { pushByPath } from "@/utils/diagnostic";

/**
 * QUE-060-01-2507-2507-M
 * Querying resource details requires returning creation and modification time parameters.
 *
 * This rule verifies that resource detail GET endpoints (typically paths containing
 * resource identifiers such as `{id}`, `{resource_id}`, etc.) return
 * both creation-time and update-time fields in the response schema.
 *
 * Behavior is controlled via rule.call.functionParams:
 * - method: string
 *   HTTP method to check (default: "get").
 * - pathMustContainPathParameter: string
 *   Generic identifier name (e.g. "id") used to detect detail endpoints. The rule
 *   matches `{id}` as well as `*_id` parameters, excluding paths that only contain
 *   `{project_id}`.
 * - responseCode: string
 *   Response code to inspect (default: "200").
 * - requiredFields: string[]
 *   Allowed aliases for creation and update time fields (e.g. create_time, created_at,
 *   update_time, updated_at). At least one create-like and one update-like field must
 *   be present somewhere in the resolved response schema.
 *
 */
export function checkTimeFieldsInDetailQuery(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const source = getSource(rule);
    const params = rule?.call?.functionParams ?? {};

    const method: string = String(params.method ?? "get").toLowerCase();
    const responseCode: string = String(params.responseCode ?? "200");
    const pathMustContainPathParameter: string | null =
        typeof params.pathMustContainPathParameter === "string" && params.pathMustContainPathParameter.trim()
            ? params.pathMustContainPathParameter.trim()
            : null;

    const requiredFieldsArr: string[] = Array.isArray(params.requiredFields)
        ? params.requiredFields.map((s: any) => String(s).trim()).filter(Boolean)
        : [];

    const createCandidates = new Set(
        requiredFieldsArr.filter((n) => /^(create_time|created_at)$/i.test(n) || /create|created/i.test(n))
    );
    const updateCandidates = new Set(
        requiredFieldsArr.filter((n) => /^(update_time|updated_at)$/i.test(n) || /update|updated/i.test(n))
    );

    if (createCandidates.size === 0) {
        createCandidates.add("create_time");
        createCandidates.add("created_at");
    }
    if (updateCandidates.size === 0) {
        updateCandidates.add("update_time");
        updateCandidates.add("updated_at");
    }

    const refCache = new Map<string, any>();

    function getPathParamNames(pathKey: string): string[] {
        const names: string[] = [];
        const re = /\{([^}]+)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(String(pathKey))) !== null) {
            const n = String(m[1] ?? "").trim();
            if (n) names.push(n);
        }
        return names;
    }

    function hasOnlyProjectIdParam(pathKey: string): boolean {
        const params = getPathParamNames(pathKey);
        if (params.length === 0) return false;
        return params.every((p) => p.toLowerCase() === "project_id");
    }

    function pathContainsParam(pathKey: string, paramName: string): boolean {
        const pn = String(paramName).trim();
        if (!pn) return false;

        const params = getPathParamNames(pathKey);
        if (params.length === 0) return false;

        if (params.some((p) => p === pn)) return true;

        // For generic names like "id", treat as "detail endpoint": must contain at least one non-project id-like param.
        if (pn.toLowerCase() === "id") {
            return params.some((p) => {
                const pl = p.toLowerCase();
                if (pl === "project_id") return false;
                return pl === "id" || pl.endsWith("_id") || pl.endsWith("id");
            });
        }

        const pnLower = pn.toLowerCase();
        return params.some((p) => p.toLowerCase().endsWith(`_${pnLower}`));
    }

    function findSchemaFromResponse(resp: any): any {
        const contentEntry = resp?.content;
        if (!contentEntry || typeof contentEntry !== "object") return null;

        const media = contentEntry["application/json"] ?? contentEntry[Object.keys(contentEntry)[0]];
        const schemaLike = media?.schema;
        if (!schemaLike) return null;
        return resolveRefDeep(schemaLike, refCache, spec);
    }

    function hasAnyKeyInSchema(schema: any, candidates: Set<string>, seen = new WeakSet<object>()): boolean {
        const s = resolveRefDeep(schema, refCache, spec);
        if (!s || typeof s !== "object") return false;
        if (seen.has(s as object)) return false;
        seen.add(s as object);

        if (s.properties && typeof s.properties === "object") {
            for (const [k, v] of Object.entries<any>(s.properties)) {
                if (candidates.has(String(k))) return true;
                if (hasAnyKeyInSchema(v, candidates, seen)) return true;
            }
        }

        // composition
        const combos: any[] = [];
        if (Array.isArray(s.allOf)) combos.push(...s.allOf);
        if (Array.isArray(s.oneOf)) combos.push(...s.oneOf);
        if (Array.isArray(s.anyOf)) combos.push(...s.anyOf);
        for (const sub of combos) {
            if (hasAnyKeyInSchema(sub, candidates, seen)) return true;
        }

        // arrays
        if (s.items) {
            if (hasAnyKeyInSchema(s.items, candidates, seen)) return true;
        }

        // maps
        if (s.additionalProperties && typeof s.additionalProperties === "object") {
            if (hasAnyKeyInSchema(s.additionalProperties, candidates, seen)) return true;
        }

        return false;
    }

    for (const pathKey of Object.keys(spec.paths)) {
        if (!pathKey.startsWith("/")) continue;

        // Exclude tag-related endpoints from this detail-query rule.
        const segments = pathKey.split("/").filter(Boolean);
        if (segments.includes("tags")) continue;

        // If the only path param is {project_id}, this is not a resource detail endpoint.
        if (hasOnlyProjectIdParam(pathKey)) continue;

        if (pathMustContainPathParameter && !pathContainsParam(pathKey, pathMustContainPathParameter)) {
            continue;
        }

        const pathItem = spec.paths[pathKey];
        const op = pathItem?.[method];
        if (!op || typeof op !== "object") continue;

        const responses = op.responses;
        if (!responses || typeof responses !== "object") continue;

        const resp = responses[responseCode];
        if (!resp || typeof resp !== "object") continue;

        const schema = findSchemaFromResponse(resp);
        if (!schema) continue;

        const hasCreate = hasAnyKeyInSchema(schema, createCandidates);
        const hasUpdate = hasAnyKeyInSchema(schema, updateCandidates);

        if (!hasCreate || !hasUpdate) {
            pushByPath(pathKey, content, method, diagnostics, rule, source);
        }
    }

    return diagnostics;
}
