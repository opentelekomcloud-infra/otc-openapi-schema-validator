import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findInvalidPercentEscape } from "@/utils/strings";
import { getSource } from "@/functions/common";
import { findPathKeyRangeInPathsBlock } from "@/utils/scan";


export function checkURIContentSyntax(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const patterns: string[] = rule?.call.functionParams?.requiredPathRegexp ?? [];

    if (!patterns.length) return diagnostics;

    // Precompile all regexes
    const regexes = patterns
        .map((p) => {
            try {
                return new RegExp(p);
            } catch (e) {
                console.error("Invalid requiredPathRegexp pattern in rule", rule?.id, p, e);
                return null;
            }
        })
        .filter((r): r is RegExp => r !== null);

    if (!regexes.length) return diagnostics;

    for (const pathKey of Object.keys(spec.paths)) {
        const isValid = regexes.some((re) => re.test(pathKey));
        const checkInvalidPercentEscape = Boolean(rule?.call?.functionParams?.checkInvalidPercentEscape);

        if (checkInvalidPercentEscape) {
            const hasPercent = pathKey.includes('%');
            const invalidEscape = findInvalidPercentEscape(pathKey);

            if (hasPercent && !invalidEscape) {
                continue;
            }
        }

        if (!isValid) {
            const range = findPathKeyRangeInPathsBlock(content, pathKey);
            diagnostics.push({
                from: range.from,
                to: range.to,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" does not conform to the required URI syntax: resource names must be lowercase and separated by hyphens, and path parameters must be in {snake_case}.`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
