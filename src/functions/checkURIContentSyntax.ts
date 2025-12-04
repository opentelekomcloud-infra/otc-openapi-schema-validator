import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";


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
        // Check if this path matches at least one of the allowed patterns
        const isValid = regexes.some((re) => re.test(pathKey));
        if (!isValid) {
            const index = content.indexOf(pathKey);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" does not conform to the required URI syntax: resource names must be lowercase and separated by hyphens, and path parameters must be in {snake_case}.`,
                source: rule.id,
            });
        }
    }

    return diagnostics;
}
