import type { Diagnostic } from "@codemirror/lint";
import { isRecord } from "@/lib/openapi/references";
import {
    configuredStatus, configuredString, responseFor, schemaRecord, selectedResponseSchema,
} from "@/utils/nativeResponse";
import { ruleDiagnostic, ruleOperations, ruleStrings, type NativeRule } from "@/utils/nativeRule";

export function checkTimeFieldsInDetailQuery(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const method = configuredString(params.method, "method", "get").toLowerCase();
    const status = configuredStatus(params.responseCode);
    const fieldConfig = params.pathMustContainPathParameter;
    if (fieldConfig !== undefined && fieldConfig !== null && typeof fieldConfig !== "string") {
        throw new Error("functionParams.pathMustContainPathParameter must be a string or null.");
    }
    const identifier = typeof fieldConfig === "string" ? fieldConfig.trim() || null : null;
    const fields = ruleStrings(params.requiredFields, "requiredFields").map((name) => name.trim()).filter(Boolean);
    const created = new Set(fields.filter((name) => /create|created/i.test(name)));
    const updated = new Set(fields.filter((name) => /update|updated/i.test(name)));
    if (!created.size) ["create_time", "created_at"].forEach((name) => created.add(name));
    if (!updated.size) ["update_time", "updated_at"].forEach((name) => updated.add(name));
    const cache = new Map<string, unknown>();
    const diagnostics: Diagnostic[] = [];
    const pathMatches = (path: string): boolean => {
        if (path.split("/").filter(Boolean).includes("tags")) return false;
        const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1].trim()).filter(Boolean);
        if (names.length && names.every((name) => name.toLowerCase() === "project_id")) return false;
        if (!identifier) return true;
        if (names.includes(identifier)) return true;
        return identifier.toLowerCase() === "id"
            ? names.some((name) => name.toLowerCase() !== "project_id" && name.toLowerCase().endsWith("id"))
            : names.some((name) => name.toLowerCase().endsWith(`_${identifier.toLowerCase()}`));
    };
    const hasField = (value: unknown, candidates: ReadonlySet<string>): boolean => {
        type Frame = { kind: "schema"; value: unknown } | { kind: "property"; name: string; value: unknown };
        const pending: Frame[] = [{ kind: "schema", value }];
        const seen = new WeakSet<object>();
        while (pending.length) {
            const frame = pending.pop();
            if (!frame) break;
            if (frame.kind === "property") {
                if (candidates.has(frame.name)) return true;
                pending.push({ kind: "schema", value: frame.value });
                continue;
            }
            const schema = schemaRecord(frame.value, spec, cache);
            if (!schema || seen.has(schema)) continue;
            seen.add(schema);
            // Reverse pushes retain the original depth-first order without recursive calls.
            if (isRecord(schema.additionalProperties)) pending.push({ kind: "schema", value: schema.additionalProperties });
            if (schema.items) pending.push({ kind: "schema", value: schema.items });
            for (const key of ["anyOf", "oneOf", "allOf"]) {
                const variants = schema[key];
                if (Array.isArray(variants)) {
                    for (let index = variants.length - 1; index >= 0; index--) {
                        pending.push({ kind: "schema", value: variants[index] });
                    }
                }
            }
            if (isRecord(schema.properties)) {
                const entries = Object.entries(schema.properties);
                for (let index = entries.length - 1; index >= 0; index--) {
                    const [name, property] = entries[index];
                    pending.push({ kind: "property", name, value: property });
                }
            }
        }
        return false;
    };
    for (const op of ruleOperations(spec, { methods: [method] }, pathMatches)) {
        const response = responseFor(op, status, spec, cache);
        if (!response?.hasBody) continue;
        const schema = selectedResponseSchema(response, spec, cache);
        if (!schema) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer, "The declared response body has no schema to verify time fields."));
        } else if (!hasField(schema.node, created) || !hasField(schema.node, updated)) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer));
        }
    }
    return diagnostics;
}
