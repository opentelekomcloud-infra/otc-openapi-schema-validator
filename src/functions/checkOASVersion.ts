import type { Diagnostic } from "@codemirror/lint";
import { jsonPointer } from "@/lib/openapi/references";
import {
    classifyForCompliance, complianceDiagnostic, complianceStringList, type ComplianceRule,
} from "@/utils/compliance";

export function checkOASVersion(spec: unknown, content: string, rule: ComplianceRule): Diagnostic[] {
    const allowed = complianceStringList(rule.call.functionParams?.allowedVersions, "allowedVersions");
    const format = classifyForCompliance(spec, content, rule);
    if (!format.ok) return [format.diagnostic];
    const versionKey = format.native.dialect === "swagger2" ? "swagger" : "openapi";
    const allowedVersion = format.native.dialect === "swagger2" ? "2.0" : "3.0";
    if (!allowed.includes(allowedVersion)) {
        return [complianceDiagnostic(
            content, rule, `'${versionKey}' version '${format.native.formatVersion}' is not allowed.`,
            jsonPointer([versionKey]), "value",
        )];
    }
    return [];
}
