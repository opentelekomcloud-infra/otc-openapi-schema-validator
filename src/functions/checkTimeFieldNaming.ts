import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { objectRange } from "@/lib/openapi/sourceMap";
import type { NativeParameterSchema, SourceRange } from "@/types/openapi";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import { getNativeSchemas } from "@/lib/openapi/schemas";
import { namingSchemas, schemaNameFields } from "@/utils/nativeNaming";
import { ruleOperations, ruleParameterNodes, ruleRequest } from "@/utils/nativeRule";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";

export function checkTimeFieldNaming(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec) return diagnostics;

    const source = getSource(rule);
    const params = rule?.call?.functionParams ?? {};
    const reported = new Set<string>();

    const recommendedArr: string[] = Array.isArray(params.recommendedNames) ? params.recommendedNames : [];
    const notRecommendedArr: string[] = Array.isArray(params.notRecommendedNames) ? params.notRecommendedNames : [];

    const recommended = new Set<string>(recommendedArr.map((s) => String(s).trim()));
    const notRecommended = new Set<string>(notRecommendedArr.map((s) => String(s).trim()));

    // Direct suggestion map for common variants.
    const suggestionMap = new Map<string, string>([
        ["created", "created_at"],
        ["updated", "updated_at"],
        ["deleted", "deleted_at"],
        ["expired", "expired_at"],
        ["createdAt", "created_at"],
        ["updatedAt", "updated_at"],
        ["create_time", "created_at"],
        ["update_time", "updated_at"],
        ["delete_time", "deleted_at"],
        ["expire_time", "expired_at"],
        ["begin_time", "start_time"],
    ]);

    const timeCandidateRe = /(?:^|[_-])(time|timestamp)(?:$|[_-])|(?:^|[_-])(created|updated|deleted|expired|expire)(?:$|[_-])|(?:_at$)/i;

    // CamelCase variants like createdAt/updatedAt. Case-sensitive to avoid matching words like "Format".
    const camelCaseAtRe = /[a-z]At$/;

    const startEndReadWithTimeRe = /(?:^|[_-])(start|end|read)(?:$|[_-]).*(?:^|[_-])(time|timestamp)(?:$|[_-])/i;

    // Ref resolution caches
    const refCache = new Map<string, any>();
    const visitedSchemas = new WeakSet<object>();

    function push(from: number, to: number, name: string, suggestion?: string) {
        // Deduplicate identical findings (common with shared schemas referenced in many places)
        const msg = suggestion
            ? `${rule.message} Found "${name}". Recommended: "${suggestion}".`
            : `${rule.message} Found "${name}".`;
        const dedupeKey = `${source}|${name}|${from}|${to}|${msg}`;
        if (reported.has(dedupeKey)) return;
        reported.add(dedupeKey);

        diagnostics.push({
            from,
            to,
            severity: mapSeverity(rule.severity),
            message: msg,
            source,
        });
    }

    function shouldEvaluate(name: string): boolean {
        if (!name) return false;
        if (recommended.has(name)) return false;
        if (notRecommended.has(name)) return true;

        const n = String(name);

        if (/^x-/i.test(n) && n.includes("-")) {
            return /(time|timestamp)/i.test(n) || /(_at$)/i.test(n) || camelCaseAtRe.test(n);
        }

        if (startEndReadWithTimeRe.test(n)) return true;
        return timeCandidateRe.test(n) || camelCaseAtRe.test(n);
    }

    function evaluateName(nameRaw: string, range: SourceRange) {
        const name = String(nameRaw).trim();
        if (!shouldEvaluate(name)) return;

        // Explicitly not recommended
        if (notRecommended.has(name)) {
            const suggestion = suggestionMap.get(name);
            const r = range;
            push(r.from, r.to, name, suggestion);
            return;
        }

        // If it looks time-related but isn't recommended, warn (best-effort).
        // Keep recommended allow-list to prevent noise on known-good names.
        if (!recommended.has(name)) {
            const suggestion = suggestionMap.get(name);
            const r = range;
            push(r.from, r.to, name, suggestion);
        }
    }

    function schemaWalk(schema: NativeParameterSchema) {
        for (const field of schemaNameFields(schema, spec, refCache, {
            maps: true, compositionsFirst: true, visited: visitedSchemas,
        })) {
            evaluateName(field.name, objectRange(spec, content, field.owner, field.name));
        }
    }

    const native = classifyNativeOpenApiDocument(spec);
    for (const op of ruleOperations(spec, {})) {
        for (const { parameter } of ruleParameterNodes(op, spec, refCache)) {
            if (native.dialect === "swagger2" && parameter.in === "body") continue;
            evaluateName(String(parameter.name), objectRange(spec, content, parameter, "name", "value"));
        }
        for (const schema of namingSchemas(ruleRequest(op, spec, refCache), spec, refCache, true)) {
            schemaWalk(schema);
        }
        for (const status of responseStatuses(op)) {
            for (const schema of namingSchemas(responseFor(op, status, spec, refCache), spec, refCache, true)) {
                schemaWalk(schema);
            }
        }
    }
    for (const { node, resolvedPointer } of getNativeSchemas(native, refCache)) {
        schemaWalk({ node, pointer: resolvedPointer });
    }

    return diagnostics;
}
