import type { Diagnostic } from "@codemirror/lint";
import { isDocumentObject } from "@/lib/openapi/parseNativeOpenApi";
import { jsonPointer } from "@/lib/openapi/references";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { collectDocumentPathEntries } from "@/lib/openapi/paths";
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
    if (params.checkDuplicateMethods !== undefined && typeof params.checkDuplicateMethods !== "boolean") {
        throw new Error("Compliance functionParams.checkDuplicateMethods must be a boolean.");
    }
    if (params.checkPathKeys !== undefined && typeof params.checkPathKeys !== "boolean") {
        throw new Error("Compliance functionParams.checkPathKeys must be a boolean.");
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

    if (params.checkPathKeys === true) {
        for (const [path] of collectDocumentPathEntries(spec)) {
            if (!path.startsWith("/")) {
                diagnostics.push(complianceDiagnostic(
                    content, rule, `Path key "${path}" must start with "/".`, jsonPointer(["paths", path]),
                ));
            }
        }
    }

    if (params.checkDuplicateMethods === true) {
        for (const duplicate of sourceMap(content).duplicateMethods()) {
            const methods = duplicate.methods.map(({ method, lines }) =>
                `${method.toUpperCase()} (${lines.length} declarations; lines ${lines.join(", ")})`).join("; ");
            diagnostics.push(complianceDiagnostic(
                content, rule, `Duplicate HTTP methods for path "${duplicate.path}": ${methods}. ` +
                    "Repeated method keys overwrite earlier declarations; only the last value is used for validation.",
                duplicate.location,
            ));
        }
    }
    return diagnostics;
}
