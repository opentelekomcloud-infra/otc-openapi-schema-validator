import type { Diagnostic } from "@codemirror/lint";
import {
    parameterExpectations, parameterMatches, ruleDiagnostic, ruleOperations, ruleParameters, ruleRequest, ruleStrings, type NativeRule,
} from "@/utils/nativeRule";

export function checkParamElementPresence(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const headers = parameterExpectations(params.headers, "headers");
    if (!headers.length) throw new Error("functionParams.headers must not be empty.");
    const triggers = parameterExpectations(params.checkOnlyIfHeaderExist === undefined ? [] : params.checkOnlyIfHeaderExist,
        "checkOnlyIfHeaderExist");
    const excluded = ruleStrings(params.exceptionPaths, "exceptionPaths");
    const alternatives = ruleStrings(params.fallBackNames, "fallBackNames");
    const section = params.checkMethodIfSectionExist;
    if (section !== undefined && typeof section !== "string") {
        throw new Error("functionParams.checkMethodIfSectionExist must be a string.");
    }
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, params)) {
        if (excluded.includes(op.path)) continue;
        if (section === "requestBody") {
            if (!ruleRequest(op, spec, cache).hasBody) continue;
        } else if (section && !op.operation[section]) continue;
        const parameters = ruleParameters(op, spec, cache);
        if (!triggers.every((trigger) => parameters.some((param) => parameterMatches(param, trigger, spec)))) continue;
        const present = headers.every((expected) =>
            parameters.some((param) => parameterMatches(param, expected, spec)) ||
            alternatives.some((name) => parameters.some((param) => parameterMatches(param, { ...expected, name }, spec))));
        if (!present) diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
    }
    return diagnostics;
}
