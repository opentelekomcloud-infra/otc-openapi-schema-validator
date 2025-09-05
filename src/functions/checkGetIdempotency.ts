import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import {getSource} from "@/functions/common";

export function checkGetIdempotency(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const disallowedPathKeywords: string[] = rule.call.functionParams.disallowedPathKeywords || [];
    const disallowRequestBody: boolean = rule.call.functionParams.disallowRequestBody === true;

    if (!spec?.paths) return diagnostics;

    for (const path in spec.paths) {
        const pathItem = spec.paths[path];
        const operation = pathItem.get;
        if (!operation || typeof operation !== "object") continue;

        const keywords = disallowedPathKeywords.map(k => k.toLowerCase());
        const pathLower = path.toLowerCase();

        const hasDisallowedKeyword = keywords.some(keyword => pathLower.includes(keyword));
        const hasRequestBody = disallowRequestBody && "requestBody" in operation;

        if (hasDisallowedKeyword || hasRequestBody) {
            const { start, end } = findMethodPositionInYaml(content, path, "get");
            diagnostics.push({
                from: start,
                to: end,
                severity: mapSeverity(rule.severity),
                message: rule.message,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
