import type { Diagnostic } from "@codemirror/lint";
import { appendPointer, isRecord, resolveObjectReference } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { configuredString, responseFor, responseStatuses, responseVariants, schemaRecord } from "@/utils/nativeResponse";
import { ruleDiagnostic, ruleOperations, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkGetReturnObject(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const method = configuredString(params.method, "method").toLowerCase();
    const requiredType = configuredString(params.requiredResponseType, "requiredResponseType");
    const required = ruleStrings(params.requiredPathRegexp, "requiredPathRegexp").map((pattern) => new RegExp(pattern));
    const excluded = ruleStrings(params.exceptionPathRegexp, "exceptionPathRegexp").map((pattern) => new RegExp(pattern));
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    const arrayWrapper = (schema: Record<string, unknown>): boolean => {
        if (schema.type !== "object" || !isRecord(schema.properties)) return false;
        const properties = schema.properties;
        const entries = Object.values(properties);
        const array = (value: unknown) => schemaRecord(value, spec, cache)?.type === "array";
        const paging = ["page", "page_info", "count"].some((name) => Object.hasOwn(properties, name));
        const anyArray = entries.some(array);
        const firstArray = entries.length > 0 && array(entries[0]);
        return (paging && anyArray) || firstArray;
    };
    const matches = (value: unknown): boolean => {
        const schema = schemaRecord(value, spec, cache);
        if (!schema) return false;
        return requiredType === "array" ? schema.type === "array" || arrayWrapper(schema) : schema.type === requiredType;
    };
    const pathMatches = (path: string) => !excluded.some((pattern) => pattern.test(path)) &&
        required.some((pattern) => pattern.test(path));
    for (const op of ruleOperations(spec, { methods: [method] }, pathMatches)) {
        for (const status of responseStatuses(op)) {
            if (!/^2\d{2}$/.test(status)) continue;
            const response = responseFor(op, status, spec, cache);
            if (!response?.hasBody) continue;
            const declarations = response.dialect === "swagger2" ? [response.schema] : response.media.map((entry) => entry.schema);
            for (const declaration of declarations) {
                const target = declaration && resolveObjectReference(declaration.node, spec, cache, declaration.pointer);
                const schema = target?.value;
                const pointer = target?.pointer ?? response.response.resolvedPointer;
                let violated = false;
                if (schema && (Object.hasOwn(schema, "oneOf") || Object.hasOwn(schema, "anyOf"))) {
                    violated = responseVariants(schema, pointer).some((variant) => !matches(variant));
                } else if (!schema || !matches(schema)) {
                    let fallback = false;
                    if (rule.id === "STC-010-01-2507-2507-M-5" && schema?.type === "object" && Array.isArray(schema.required)) {
                        if (!schema.required.every((field: unknown) => typeof field === "string")) {
                            throw new NativeAccessorError("INVALID_SCHEMA", appendPointer(pointer, "required"), "Expected required field names");
                        }
                        fallback = schema.required.some((field: string) => field.endsWith("s"));
                    }
                    violated = !fallback;
                }
                if (violated) diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
            }
        }
    }
    return diagnostics;
}
