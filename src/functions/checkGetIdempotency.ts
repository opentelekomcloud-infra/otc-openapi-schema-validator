import type { Diagnostic } from "@codemirror/lint";
import { configuredBoolean } from "@/utils/nativeResponse";
import { ruleDiagnostic, ruleOperations, ruleRequest, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkGetIdempotency(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const keywords = ruleStrings(params.disallowedPathKeywords, "disallowedPathKeywords").map((key) => key.toLowerCase());
    const disallowBody = configuredBoolean(params.disallowRequestBody, "disallowRequestBody", false);
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, { methods: ["get"] })) {
        if (keywords.some((key) => op.path.toLowerCase().includes(key)) ||
            (disallowBody && ruleRequest(op, spec, cache).hasBody)) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
        }
    }
    return diagnostics;
}
