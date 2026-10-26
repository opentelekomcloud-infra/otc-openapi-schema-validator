import type { Diagnostic } from "@codemirror/lint";
import { isRecord } from "@/lib/openapi/references";
import {
    configuredBoolean, configuredStatus, configuredString, responseFor, responseVariants,
    schemaRecord, selectedResponseSchema,
} from "@/utils/nativeResponse";
import { ruleDiagnostic, ruleOperations, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkResponseIncludesCount(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const method = configuredString(params.method, "method", "get").toLowerCase();
    const status = configuredStatus(params.responseCode);
    const noPathParams = configuredBoolean(params.pathMustNotContainPathParams, "pathMustNotContainPathParams", false);
    const containsArray = configuredBoolean(params.responseContainArray, "responseContainArray", false);
    const required = configuredBoolean(params.required, "required", true);
    const fieldName = configuredString(params.fieldName, "fieldName", "count");
    const fieldType = configuredString(params.fieldType, "fieldType", "integer");
    const allowed = new Set(ruleStrings(params.allowedNames === undefined ? [fieldName] : params.allowedNames, "allowedNames")
        .map((name) => name.trim()).filter(Boolean));
    const disallowed = new Set(ruleStrings(params.disallowedNames, "disallowedNames").map((name) => name.trim()).filter(Boolean));
    const cache = new Map<string, unknown>();
    const diagnostics: Diagnostic[] = [];
    const arrayPayload = (value: unknown): boolean => {
        const schema = schemaRecord(value, spec, cache);
        if (!schema) return false;
        return schema.type === "array" || (schema.type === "object" && isRecord(schema.properties) &&
            Object.values(schema.properties).some((property) => schemaRecord(property, spec, cache)?.type === "array"));
    };
    const countField = (value: unknown): { ok: boolean; disallowed?: boolean } => {
        const schema = schemaRecord(value, spec, cache);
        if (!schema || schema.type !== "object" || !isRecord(schema.properties)) return { ok: false };
        for (const name of disallowed) {
            if (Object.hasOwn(schema.properties, name)) return { ok: false, disallowed: true };
        }
        for (const name of allowed) {
            if (Object.hasOwn(schema.properties, name)) {
                return { ok: schemaRecord(schema.properties[name], spec, cache)?.type === fieldType };
            }
        }
        return { ok: false };
    };
    const pathMatches = (path: string) => !noPathParams || !/\{[^}]+\}/.test(path);
    for (const op of ruleOperations(spec, { methods: [method] }, pathMatches)) {
        const response = responseFor(op, status, spec, cache);
        if (!response?.hasBody) continue;
        const selected = selectedResponseSchema(response, spec, cache);
        if (!selected) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer, "The declared response body has no schema to verify count."));
            continue;
        }
        const variants = responseVariants(selected.node, selected.pointer);
        if (containsArray && !variants.some(arrayPayload)) continue;
        if (required && variants.some((variant) => schemaRecord(variant, spec, cache)?.type === "array")) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
            continue;
        }
        const violated = variants.some((variant) => {
            if (containsArray && !arrayPayload(variant)) return false;
            const result = countField(variant);
            return required ? !result.ok : result.disallowed === true;
        });
        if (violated) diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
    }
    return diagnostics;
}
