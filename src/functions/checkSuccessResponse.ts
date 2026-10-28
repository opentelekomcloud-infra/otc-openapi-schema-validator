import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import { getSource } from "@/functions/common";
import { ruleOperations } from "@/utils/nativeRule";
import { appendPointer, isRecord } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";

export function checkSuccessResponse(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const method: string | string[] = rule.call.functionParams.method || "get";
    const requiredStatusCode: string | number | (string | number)[] = rule.call.functionParams.requiredStatusCode || "200";

    if (!spec?.paths) return diagnostics;

    const methods = Array.isArray(method) ? method : [method];
    const codes = Array.isArray(requiredStatusCode) ? requiredStatusCode : [requiredStatusCode];
    for (const op of ruleOperations(spec, { methods })) {
        const responses = op.operation.responses ?? {};
        if (!isRecord(responses)) {
            throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(op.pointer, "responses"), "Expected a responses object");
        }
        const missingCodes = codes.filter(code => !Object.hasOwn(responses, code));
        if (missingCodes.length > 0) {
            const { start: from, end: to } = findMethodPositionInYaml(content, op.path, op.method);
            diagnostics.push({
                from,
                to,
                severity: mapSeverity(rule.severity),
                message: `${rule.message} Missing: ${missingCodes.join(", ")}`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
