import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

export function checkOASSpec(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const required = rule.call.functionParams.requiredValues || [];
    const optional = rule.call.functionParams.optionalValues || [];
    const topLevelKeys = Object.keys(spec || {});
    for (const key of required) {
        if (!(key in spec)) {
            diagnostics.push({
                from: 0,
                to: content.length,
                severity: mapSeverity(rule.severity),
                message: `'${rule.message}' Missing required top-level field: '${key}'`,
                source: getSource(rule),
            });
        }
    }

    for (const key of topLevelKeys) {
        if (!required.includes(key) && !optional.includes(key)) {
            const index = content.indexOf(key);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + key.length : content.length,
                severity: mapSeverity(rule.severity),
                message: `'${rule.message}' Disallowed top-level field: '${key}'`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
