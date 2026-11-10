import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { pathRange } from "@/lib/openapi/sourceMap";
import { ruleOperations, ruleStrings } from "@/utils/nativeRule";

export function checkCRUD(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const createMethods: string[] = rule.call.functionParams.createMethod || ["post"];
    const requiredMethods: string[] = rule.call.functionParams.requiredMethods || ["get", "put", "delete"];
    const optionalMethods: string[] = rule.call.functionParams.optionalMethods || [];

    if (!spec?.paths) return diagnostics;

    const exceptionPaths: string[] = rule.call.functionParams.exceptionPaths || [];
    const configuredActions = rule.call.functionParams.nonCrudActions;
    const nonCrudActions = new Set(ruleStrings(
        configuredActions === undefined ? ["action", "actions"] : configuredActions, "nonCrudActions",
    ).map(name => name.trim().toLowerCase()).filter(Boolean));

    const operations = ruleOperations(spec, {}, (path) => {
        const tail = path.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
        if (!/^\{[^{}]+\}$/.test(tail) &&
            (nonCrudActions.has(tail) || tail.split(/[-_]+/).some(word => nonCrudActions.has(word)))) return false;
        return !exceptionPaths.some(excPath => {
            if (excPath.endsWith("*")) {
                const prefix = excPath.slice(0, -1);
                return path.startsWith(prefix);
            }
            return path === excPath;
        });
    });
    const methodsByPath = new Map<string, Set<string>>();
    const itemMethodsByCollection = new Map<string, Set<string>>();
    for (const { path, method } of operations) {
        const methods = methodsByPath.get(path) ?? new Set<string>();
        methods.add(method);
        methodsByPath.set(path, methods);
        const itemPath = path.match(/^(.*)\/\{[^/{}]+\}\/?$/);
        if (itemPath) {
            const itemMethods = itemMethodsByCollection.get(itemPath[1]) ?? new Set<string>();
            itemMethods.add(method);
            itemMethodsByCollection.set(itemPath[1], itemMethods);
        }
    }
    const normalizedCreateMethods = createMethods.map(m => m.toLowerCase().trim());
    const normalizedRequiredMethods = requiredMethods.map(m => m.toLowerCase().trim());
    const normalizedOptionalMethods = optionalMethods.map(m => m.toLowerCase().trim());

    for (const [path, methodsInPath] of methodsByPath) {
        const hasCreateMethod = normalizedCreateMethods.some(createMethod => methodsInPath.has(createMethod));
        if (!hasCreateMethod) continue;

        const itemMethods = itemMethodsByCollection.get(path.replace(/\/$/, ""));
        const missingMethods = normalizedRequiredMethods
            .filter(reqMethod => !methodsInPath.has(reqMethod) && !itemMethods?.has(reqMethod))
            .filter(missing => !normalizedOptionalMethods.includes(missing));

        if (missingMethods.length > 0) {
            const range = pathRange(content, path);
            diagnostics.push({
                from: range.from,
                to: range.to,
                severity: mapSeverity(rule.severity),
                message: `${rule.message} Missing: ${missingMethods.join(", ")}`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
