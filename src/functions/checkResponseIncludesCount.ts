import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";
import { resolveRefDeep } from "@/utils/schema";
import { pushByPath } from "@/utils/diagnostic";

/**
 * QUE-040-01-2507-2507-M
 * Ensures GET list responses include total matching resources using standardized `count` field.
 *
 * Uses rule.call.functionParams:
 * - method: string (e.g. "get")
 * - pathMustNotContainPathParams: boolean
 * - responseCode: string (e.g. "200")
 * - responseContainArray: boolean
 * - fieldName: string (e.g. "count")
 * - fieldType: string (e.g. "integer")
 * - required: boolean
 * - allowedNames: string[]
 * - disallowedNames: string[]
 */
export function checkResponseIncludesCount(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec?.paths) return diagnostics;

    const params = rule?.call?.functionParams ?? {};

    const method: string = String(params.method ?? "get").toLowerCase();
    const pathMustNotContainPathParams: boolean = Boolean(params.pathMustNotContainPathParams);
    const responseCode: string = String(params.responseCode ?? "200");
    const responseContainArray: boolean = Boolean(params.responseContainArray);
    const fieldName: string = String(params.fieldName ?? "count");
    const fieldType: string = String(params.fieldType ?? "integer");
    const required: boolean = params.required !== undefined ? Boolean(params.required) : true;

    const allowedNames: Set<string> = new Set(
        (Array.isArray(params.allowedNames) ? params.allowedNames : [fieldName])
            .map((s: any) => String(s).trim())
            .filter(Boolean)
    );

    const disallowedNames: Set<string> = new Set(
        (Array.isArray(params.disallowedNames) ? params.disallowedNames : [])
            .map((s: any) => String(s).trim())
            .filter(Boolean)
    );

    const source = getSource(rule);

    const refCache = new Map<string, any>();

    function isPathParamPath(path: string): boolean {
        return /\{[^}]+\}/.test(path);
    }

    function findSchemaFromResponse(response: any): any {
        const contentEntry = response?.content;
        if (!contentEntry || typeof contentEntry !== "object") return null;

        // Prefer application/json, otherwise take first
        const media = contentEntry["application/json"] ?? contentEntry[Object.keys(contentEntry)[0]];
        const schemaLike = media?.schema;
        if (!schemaLike) return null;
        return resolveRefDeep(schemaLike, refCache, spec);
    }

    function schemaContainsArrayPayload(schema: any): boolean {
        const s = resolveRefDeep(schema, refCache, spec);
        if (!s || typeof s !== "object") return false;

        if (s.type === "array") return true;

        if (s.type === "object" && s.properties && typeof s.properties === "object") {
            return Object.values<any>(s.properties).some((v) => {
                const pv = resolveRefDeep(v, refCache, spec);
                return pv?.type === "array";
            });
        }

        return false;
    }

    function schemaHasCountField(schema: any): { ok: boolean; reason?: string } {
        const s = resolveRefDeep(schema, refCache, spec);
        if (!s || typeof s !== "object") return { ok: false, reason: "missing schema" };

        if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
            return { ok: false, reason: "response schema is not an object" };
        }

        for (const bad of disallowedNames) {
            if (Object.prototype.hasOwnProperty.call(s.properties, bad)) {
                return { ok: false, reason: `disallowed field \"${bad}\" present` };
            }
        }

        for (const good of allowedNames) {
            if (Object.prototype.hasOwnProperty.call(s.properties, good)) {
                const propSchema = resolveRefDeep((s.properties as any)[good], refCache, spec);
                const t = propSchema?.type;
                if (t === fieldType) return { ok: true };
                return { ok: false, reason: `field \"${good}\" must be type \"${fieldType}\"` };
            }
        }

        return { ok: false, reason: `missing required field \"${fieldName}\"` };
    }

    for (const path in spec.paths) {
        if (pathMustNotContainPathParams && isPathParamPath(path)) continue;

        const pathItem = spec.paths[path];
        const operation = pathItem?.[method];
        if (!operation || typeof operation !== "object") continue;

        const responses = operation.responses;
        if (!responses || typeof responses !== "object") continue;

        const response = responses[responseCode];
        if (!response || typeof response !== "object") continue;

        let schema = findSchemaFromResponse(response);
        if (!schema) continue;

        schema = resolveRefDeep(schema, refCache, spec);
        const variants = (schema?.oneOf || schema?.anyOf) && Array.isArray(schema.oneOf || schema.anyOf)
            ? (schema.oneOf || schema.anyOf)
            : null;

        const toCheck = variants ?? [schema];

        let shouldEnforce = true;
        if (responseContainArray) {
            shouldEnforce = toCheck.some((s: any) => schemaContainsArrayPayload(s));
        }

        if (!shouldEnforce) continue;

        if (required) {
            const anyBareArray = toCheck.some((s: any) => {
                const rs = resolveRefDeep(s, refCache, spec);
                return rs?.type === "array";
            });
            if (anyBareArray) {
                pushByPath(path, content, method, diagnostics, rule, source);
                continue;
            }
        }

        let violated = false;
        for (const s of toCheck) {
            const rs = resolveRefDeep(s, refCache, spec);
            if (!rs) continue;

            if (responseContainArray && !schemaContainsArrayPayload(rs)) continue;

            const res = schemaHasCountField(rs);
            if (required && !res.ok) {
                violated = true;
                break;
            }

            if (!required && res.reason && res.reason.startsWith("disallowed field")) {
                violated = true;
                break;
            }
        }

        if (violated) {
            pushByPath(path, content, method, diagnostics, rule, source);
        }
    }

    return diagnostics;
}
