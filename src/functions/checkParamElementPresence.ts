import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import { matchParameterSchema } from "@/utils/schema";

export function checkParamElementPresence(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec?.paths) return diagnostics;

    const seen = new Set<string>();
    const checkOnlyIf = rule.call.functionParams.checkMethodIfSectionExist || "";
    const excludedPaths = rule.call.functionParams.exceptionPaths || [];

    for (const path in spec.paths) {
        if (excludedPaths.includes(path)) continue;
        const pathItem = spec.paths[path];

        const methodsToCheck = rule.call.functionParams.methods || Object.keys(pathItem);
        for (const method of methodsToCheck) {
            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            if (checkOnlyIf && !operation[checkOnlyIf]) continue;

            const key = `${path}|${method}`;
            if (seen.has(key)) continue;

            const parameters = operation.parameters || [];

            const headers = rule.call.functionParams.headers || [];

            const allHeadersPresent = headers.every((header: any) =>
                parameters.some((param: any) =>
                    matchParameterSchema(
                        param,
                        header.name,
                        header.in,
                        header.valueType,
                        spec,
                        {
                            required: header.required,
                            description: header.description,
                            style: header.style,
                        }
                    )
                )
            );

            if (!allHeadersPresent) {
                seen.add(key);
                const { start, end } = findMethodPositionInYaml(content, path, method);
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: rule.message,
                    source: rule.id,
                });
            }
        }
    }

    return diagnostics;
}
