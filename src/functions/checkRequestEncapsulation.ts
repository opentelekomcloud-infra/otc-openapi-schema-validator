import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer } from "@/lib/openapi/references";
import { matchesMediaType, parseDeclaredMediaType } from "@/utils/mediaType";
import { ruleDiagnostic, ruleOperations, ruleRequest, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkRequestEncapsulation(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    if (rule.element !== undefined && typeof rule.element !== "string") {
        throw new Error("Request body rule.element must be a string.");
    }
    if (typeof rule.element === "string" && rule.element !== "requestBody") {
        return checkLegacyRequestEncapsulation(spec, content, rule);
    }
    const params = rule.call.functionParams ?? {};
    const allowed = ruleStrings(params.content, "content").map((type) => parseDeclaredMediaType(type, "#"));
    if (!allowed.length) throw new Error("functionParams.content must not be empty.");
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, {})) {
        const request = ruleRequest(op, spec, cache);
        if (!request.hasBody) continue;
        const declared = request.media.map((entry) => parseDeclaredMediaType(entry.mediaType, entry.pointer));
        if (!declared.some((type) => allowed.some((expected) => matchesMediaType(type, expected)))) {
            const pointer = request.mediaTypes.state === "declared" ? request.mediaTypes.pointer
                : request.kind === "body" ? request.body.resolvedPointer : op.pointer;
            diagnostics.push(ruleDiagnostic(content, rule, pointer));
        }
    }
    return diagnostics;
}

function checkLegacyRequestEncapsulation(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const requestBodyKey: string = rule.element;
    const contentTypes: string[] = rule.call.functionParams.content || [];

    if (!spec?.paths) return diagnostics;

    for (const pathKey in spec.paths) {
        const pathItem = spec.paths[pathKey];

        for (const method in pathItem) {
            const operation = pathItem[method];
            if (!operation || typeof operation !== "object") continue;

            const requestBody = operation[requestBodyKey];
            if (!requestBody || typeof requestBody !== "object") continue;

            const contentKeys = Object.keys(requestBody.content || {});
            const hasRequiredContentType = contentTypes.some(type => contentKeys.includes(type));

            if (!hasRequiredContentType) {
                const { from: start, to: end } = sourceMap(content).locate(jsonPointer(["paths", pathKey, method, requestBodyKey]));
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: rule.message,
                    source: getSource(rule),
                });
            }
        }
    }

    return diagnostics;
}
