import type { Diagnostic } from "@codemirror/lint";
import { isDocumentObject } from "@/lib/openapi/parseNativeOpenApi";
import { jsonPointer } from "@/lib/openapi/references";
import {
    classifyForCompliance, complianceDiagnostic, complianceStringList, type ComplianceRule,
} from "@/utils/compliance";

export function checkOASSpec(spec: unknown, content: string, rule: ComplianceRule): Diagnostic[] {
    if (!isDocumentObject(spec)) {
        return [complianceDiagnostic(content, rule, "The specification root must be an object.")];
    }
    const params = rule.call.functionParams ?? {};
    if (params.allowExtensions !== undefined && typeof params.allowExtensions !== "boolean") {
        throw new Error("Compliance functionParams.allowExtensions must be a boolean.");
    }
    let formatParams = params;
    if (params.formats !== undefined) {
        if (!isDocumentObject(params.formats)) {
            throw new Error("Compliance functionParams.formats must be an object.");
        }
        const format = classifyForCompliance(spec, content, rule);
        if (!format.ok) return [format.diagnostic];
        const key = format.native.dialect === "swagger2" ? "swagger" : "openapi";
        const template = params.formats[key];
        if (!Object.hasOwn(params.formats, key) || !isDocumentObject(template)) {
            throw new Error(`Compliance functionParams.formats.${key} must be an object.`);
        }
        formatParams = template;
    }
    const required = complianceStringList(formatParams.requiredValues, "requiredValues");
    const optional = complianceStringList(formatParams.optionalValues, "optionalValues");
    const diagnostics: Diagnostic[] = [];
    for (const key of required) {
        if (!Object.hasOwn(spec, key)) {
            diagnostics.push(complianceDiagnostic(content, rule, `Missing required top-level field: '${key}'`));
        }
    }

    for (const key of Object.keys(spec)) {
        const extensionAllowed = params.allowExtensions === true && key.startsWith("x-");
        if (!required.includes(key) && !optional.includes(key) && !extensionAllowed) {
            diagnostics.push(complianceDiagnostic(
                content, rule, `Disallowed top-level field: '${key}'`, jsonPointer([key]),
            ));
        }
    }

    return diagnostics;
}
