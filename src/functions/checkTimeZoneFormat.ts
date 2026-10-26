import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { resolveRefDeep } from "@/utils/schema";
import { objectRange } from "@/lib/openapi/sourceMap";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import { getNativeSchemas } from "@/lib/openapi/schemas";
import { isRecord } from "@/lib/openapi/references";

export function checkTimeZoneFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec) return diagnostics;

    const source = getSource(rule);

    const params = rule?.call?.functionParams ?? {};
    const namesArr: string[] = Array.isArray(params.parameterNames) ? params.parameterNames : [];
    const preferredFormatStr: string = typeof params.preferredFormat === "string" ? params.preferredFormat : "";

    if (!namesArr.length || !preferredFormatStr) return diagnostics;

    const parameterNames = new Set(namesArr.map((s) => String(s).trim().toLowerCase()));
    const preferredRe = new RegExp(preferredFormatStr);

    const reported = new Set<string>();
    const refCache = new Map<string, any>();

    function push(schemaName: string, property: unknown, propName: string, example: string) {
        const msg = `${rule.message}\nFound example for "${propName}": ${example}`;

        const r = objectRange(spec, content, property, "example", "value");

        const dedupeKey = `${source}|${schemaName}|${propName}|${example}`;
        if (reported.has(dedupeKey)) return;
        reported.add(dedupeKey);

        diagnostics.push({
            from: r.from,
            to: r.to,
            severity: mapSeverity(rule.severity),
            message: msg,
            source,
        });
    }

    for (const { name: schemaName, node: schema } of getNativeSchemas(classifyNativeOpenApiDocument(spec), refCache)) {
        const props = schema.properties;
        if (!isRecord(props)) continue;

        const propKeyByLower = new Map<string, string>();
        for (const k of Object.keys(props)) {
            propKeyByLower.set(String(k).toLowerCase(), String(k));
        }

        for (const pnLower of parameterNames) {
            const actualKey = propKeyByLower.get(pnLower);
            if (!actualKey) continue;

            const propSchema = props[actualKey];
            const resolvedProp = resolveRefDeep(propSchema, refCache, spec);
            const ex = resolvedProp?.example;

            if (ex === undefined) continue;

            if (ex instanceof Date) {
                const iso = ex.toISOString();
                if (!preferredRe.test(iso)) push(schemaName, resolvedProp, actualKey, iso);
                continue;
            }

            if (typeof ex !== "string") {
                push(schemaName, resolvedProp, actualKey, String(ex));
                continue;
            }

            const exStr = ex.trim();

            if (exStr.length === 0) {
                push(schemaName, resolvedProp, actualKey, exStr);
                continue;
            }

            if (!preferredRe.test(exStr)) {
                const t = Date.parse(exStr);
                if (Number.isNaN(t)) {
                    push(schemaName, resolvedProp, actualKey, exStr);
                }
            }
        }
    }

    return diagnostics;
}
