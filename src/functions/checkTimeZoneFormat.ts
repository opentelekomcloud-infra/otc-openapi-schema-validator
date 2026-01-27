import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { resolveRefDeep } from "@/utils/schema";
import { findKeyRangeInContent } from "@/utils/pos";

export function checkTimeZoneFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec) return diagnostics;

    const source = getSource(rule);

    const params = rule?.call?.functionParams ?? {};
    const namesArr: string[] = Array.isArray(params.parameterNames) ? params.parameterNames : [];
    const preferredFormatStr: string = typeof params.preferredFormat === "string" ? params.preferredFormat : "";

    if (!namesArr.length || !preferredFormatStr) return diagnostics;

    const parameterNames = new Set(namesArr.map((s) => String(s).trim().toLowerCase()));
    let preferredRe: RegExp;
    try {
        preferredRe = new RegExp(preferredFormatStr);
    } catch {
        return diagnostics;
    }

    const reported = new Set<string>();
    const refCache = new Map<string, any>();

    function findSchemaAnchor(schemaName: string): number {
        const componentsIdx = content.indexOf("\ncomponents:");
        const schemasIdx = componentsIdx >= 0 ? content.indexOf("\n  schemas:", componentsIdx) : -1;
        const searchFrom = schemasIdx >= 0 ? schemasIdx : 0;

        // YAML indentation under schemas is typically 4 spaces.
        const needles = [`\n    ${schemaName}:`, `\n  ${schemaName}:`, `\n${schemaName}:`];
        for (const n of needles) {
            const idx = content.indexOf(n, searchFrom);
            if (idx >= 0) return idx;
        }
        return -1;
    }

    function push(schemaName: string, propName: string, example: string) {
        const msg = `${rule.message}\nFound example for "${propName}": ${example}`;

        const schemaAnchor = findSchemaAnchor(schemaName);
        const r = findKeyRangeInContent(content, propName, schemaAnchor >= 0 ? schemaAnchor : undefined);

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

    // Simple scan: components.schemas -> schema.properties -> time fields
    const schemasObj = spec.components.schemas;
    for (const [schemaNameRaw, schemaDef] of Object.entries<any>(schemasObj)) {
        const schemaName = String(schemaNameRaw);
        const schema = resolveRefDeep(schemaDef, refCache, spec);
        if (!schema || typeof schema !== "object") continue;

        const props = schema.properties;
        if (!props || typeof props !== "object") continue;

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
                if (!preferredRe.test(iso)) push(schemaName, actualKey, iso);
                continue;
            }

            if (typeof ex !== "string") {
                push(schemaName, actualKey, String(ex));
                continue;
            }

            const exStr = ex.trim();

            if (exStr.length === 0) {
                push(schemaName, actualKey, exStr);
                continue;
            }

            if (!preferredRe.test(exStr)) {
                const t = Date.parse(exStr);
                if (Number.isNaN(t)) {
                    push(schemaName, actualKey, exStr);
                }
            }
        }
    }

    return diagnostics;
}
