import type { Diagnostic } from "@codemirror/lint";
import { getParameterSchema } from "@/lib/openapi/parameters";
import { appendPointer } from "@/lib/openapi/references";
import { ruleDiagnostic, ruleOperations, ruleParameterNodes, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkElementSensitiveData(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const names = ruleStrings(params.queryNotAllowed, "queryNotAllowed");
    if (!names.length) throw new Error("functionParams.queryNotAllowed must not be empty.");
    const locations = ruleStrings(params.parameterLocations === undefined
        ? (typeof rule.element === "string" ? [rule.element] : undefined) : params.parameterLocations, "parameterLocations");
    if (!locations.length) throw new Error("A parameter location must be configured.");
    if (params.valueType !== undefined && typeof params.valueType !== "string") {
        throw new Error("functionParams.valueType must be a string.");
    }
    if (params.matchByNameOnly !== undefined && typeof params.matchByNameOnly !== "boolean") {
        throw new Error("functionParams.matchByNameOnly must be a boolean.");
    }
    const type = params.valueType ?? (params.matchByNameOnly === true ? undefined : "string");
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, params)) {
        const parameters = ruleParameterNodes(op, spec, cache);
        for (const name of names) {
            const found = parameters.find((param) => (param.parameter.in === "header"
                ? String(param.parameter.name).toLowerCase() === name.toLowerCase() : param.parameter.name === name) &&
                locations.includes(String(param.parameter.in)) && (type === undefined ||
                    getParameterSchema(param.parameter, spec, cache, param.resolvedPointer)?.node.type === type));
            if (!found) continue;
            diagnostics.push(ruleDiagnostic(content, rule, appendPointer(found.resolvedPointer, "name"), "", "value"));
            break;
        }
    }
    return diagnostics;
}
