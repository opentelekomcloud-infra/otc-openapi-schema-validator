import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer } from "@/lib/openapi/references";

export function checkOASSpec(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const format = spec?.swagger !== undefined && spec?.openapi === undefined ? "swagger" : "openapi";
    const params = rule.call.functionParams;
    const formatParams = params.formats?.[format] ?? params;
    const required: string[] = formatParams.requiredValues || [];
    const optional: string[] = formatParams.optionalValues || [];
    const topLevelKeys = Object.keys(spec || {});
    for (const key of required) {
        if (!(key in spec)) {
            diagnostics.push({
                ...sourceMap(content).locate("#"),
                severity: mapSeverity(rule.severity),
                message: `'${rule.message}' Missing required top-level field: '${key}'`,
                source: getSource(rule),
            });
        }
    }

    for (const key of topLevelKeys) {
        if (!required.includes(key) && !optional.includes(key)) {
            const range = sourceMap(content).locate(jsonPointer([key]));
            diagnostics.push({
                from: range.from,
                to: range.to,
                severity: mapSeverity(rule.severity),
                message: `'${rule.message}' Disallowed top-level field: '${key}'`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
