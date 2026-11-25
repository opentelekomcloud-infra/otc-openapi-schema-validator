import type { Diagnostic } from "@codemirror/lint";
import { isRecord } from "@/lib/openapi/references";
import {
    configuredStatus, configuredString, responseFor, schemaRecord, selectedResponseSchema,
} from "@/utils/nativeResponse";
import { ruleDiagnostic, ruleOperations, ruleStrings, type NativeRule } from "@/utils/nativeRule";

function resourcePath(path: string): string {
    return path.replace(/\/+$/, "").replace(/\/\{[^/{}]+\}$/, "").replace(/\{[^/{}]+\}/g, "{}");
}

function timeFieldProfiles(value: unknown) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("functionParams.timeFieldProfiles must be an array.");
    return value.map((profile: unknown, index: number) => {
        const field = `timeFieldProfiles[${index}]`;
        if (!isRecord(profile)) throw new Error(`functionParams.${field} must be an object.`);
        const resourceKeywords = ruleStrings(profile.resourceKeywords, `${field}.resourceKeywords`)
            .map((word) => word.trim().toLowerCase());
        const requiredFields = ruleStrings(profile.requiredFields, `${field}.requiredFields`).map((name) => name.trim());
        if (!resourceKeywords.length || resourceKeywords.some((word) => !/^[a-z0-9]+$/.test(word))) {
            throw new Error(`functionParams.${field}.resourceKeywords must contain non-empty alphanumeric words.`);
        }
        if (!requiredFields.length || requiredFields.some((name) => !name)) {
            throw new Error(`functionParams.${field}.requiredFields must contain non-empty field names.`);
        }
        return { resourceKeywords, requiredFields: [...new Set(requiredFields)] };
    });
}

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
    if (!created.size) created.add("created_at");
    if (!updated.size) updated.add("updated_at");
    const profiles = timeFieldProfiles(params.timeFieldProfiles);
    const profileFor = (path: string) => {
        const resource = path.split("/").filter((segment) => segment && !/^\{[^{}]+\}$/.test(segment)).pop() ?? "";
        const words = resource.toLowerCase().split(/[-_]+/);
        return profiles.find((profile) => profile.resourceKeywords.some((word) => words.includes(word)));
    };
    const cache = new Map<string, unknown>();
    const diagnostics: Diagnostic[] = [];
    const pathMatches = (path: string): boolean => {
        if (path.split("/").filter(Boolean).includes("tags")) return false;
        const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1].trim()).filter(Boolean);
        if (names.length && names.every((name) => name.toLowerCase() === "project_id")) return false;
        if (!identifier || profileFor(path)) return true;
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
    const queries = ruleOperations(spec, { methods: [method] }, pathMatches)
        .map((op) => ({ op, profile: profileFor(op.path) }));
    const resources = new Set(queries.filter(({ profile }) => !profile).map(({ op }) => resourcePath(op.path)));
    const updatable = new Set(ruleOperations(spec, { methods: ["put", "patch"] },
        (path) => resources.has(resourcePath(path))).map((op) => resourcePath(op.path)));
    for (const { op, profile } of queries) {
        const response = responseFor(op, status, spec, cache);
        if (!response?.hasBody) continue;
        const schema = selectedResponseSchema(response, spec, cache);
        if (!schema) {
            diagnostics.push(ruleDiagnostic(content, rule, op.pointer, "The declared response body has no schema to verify time fields."));
        } else {
            const required = profile ? profile.requiredFields.map((name) => new Set([name]))
                : updatable.has(resourcePath(op.path)) ? [created, updated] : [created];
            const missing = required
                .filter((candidates) => !hasField(schema.node, candidates))
                .map((candidates) => [...candidates].map((name) => `'${name}'`).join(" or "));
            if (missing.length) {
                diagnostics.push(ruleDiagnostic(content, rule, op.pointer,
                    `Missing in response schema for status '${status}': ${missing.join(", ")}.`));
            }
        }
    }
    return diagnostics;
}
