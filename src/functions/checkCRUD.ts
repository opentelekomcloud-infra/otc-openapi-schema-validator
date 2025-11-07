import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

export function checkCRUD(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const createMethods: string[] = rule.call.functionParams.createMethod || ["post"];
    const requiredMethods: string[] = rule.call.functionParams.requiredMethods || ["get", "put", "delete"];
    const optionalMethods: string[] = rule.call.functionParams.optionalMethods || [];

    if (!spec?.paths) return diagnostics;

    const exceptionPaths: string[] = rule.call.functionParams.exceptionPaths || [];

    for (const path in spec.paths) {
        const isException = exceptionPaths.some(excPath => {
            if (excPath.endsWith("*")) {
                const prefix = excPath.slice(0, -1);
                return path.startsWith(prefix);
            }
            return path === excPath;
        });
        if (isException) continue;


        const pathItem = spec.paths[path];
        const methodsInPath = Object.keys(pathItem || {}).map(m => m.toLowerCase().trim());
        const normalizedCreateMethods = createMethods.map(m => m.toLowerCase().trim());
        const normalizedRequiredMethods = requiredMethods.map(m => m.toLowerCase().trim());
        const normalizedOptionalMethods = optionalMethods.map(m => m.toLowerCase().trim());

        const hasCreateMethod = normalizedCreateMethods.some(createMethod => methodsInPath.includes(createMethod));
        if (!hasCreateMethod) continue;

        const missingMethods = normalizedRequiredMethods
            .filter(reqMethod => !methodsInPath.includes(reqMethod))
            .filter(missing => !normalizedOptionalMethods.includes(missing));

        if (missingMethods.length > 0) {
            function escapeRegExp(string: string): string {
                return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }

            const pathPattern = new RegExp(`^\\s*["']?${escapeRegExp(path)}["']?:`, "m");
            const match = content.match(pathPattern);
            const pathIndex = match?.index ?? -1;
            diagnostics.push({
                from: pathIndex >= 0 ? pathIndex : 0,
                to: pathIndex >= 0 ? pathIndex + path.length : content.length,
                severity: mapSeverity(rule.severity),
                message: `${rule.message} Missing: ${missingMethods.join(", ")}`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
