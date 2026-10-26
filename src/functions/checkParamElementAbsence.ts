import type { Diagnostic } from "@codemirror/lint";
import {
    parameterExpectations, parameterMatches, ruleDiagnostic, ruleOperations, ruleParameters, ruleRequest, ruleStrings, type NativeRule,
} from "@/utils/nativeRule";

export function checkParamElementAbsence(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const headers = parameterExpectations(params.headers, "headers");
    if (!headers.length) throw new Error("functionParams.headers must not be empty.");
    const excluded = ruleStrings(params.exceptionPaths, "exceptionPaths");
    const section = params.checkMethodIfSectionExist;
    if (section !== undefined && typeof section !== "string") {
        throw new Error("functionParams.checkMethodIfSectionExist must be a string.");
    }
    if (params.whenRequestBodyAbsent !== undefined && typeof params.whenRequestBodyAbsent !== "boolean") {
        throw new Error("functionParams.whenRequestBodyAbsent must be a boolean.");
    }
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, params)) {
        if (excluded.includes(op.path)) continue;
        if (section && section !== "requestBody" && !op.operation[section]) continue;
        if (section === "requestBody" || params.whenRequestBodyAbsent === true) {
            const hasBody = ruleRequest(op, spec, cache).hasBody;
            if ((section === "requestBody" && !hasBody) || (params.whenRequestBodyAbsent === true && hasBody)) continue;
        }
        const parameters = ruleParameters(op, spec, cache);
        if (headers.every((expected) => parameters.some((param) => parameterMatches(param, expected, spec)))) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
        }
    }
    return diagnostics;
}
