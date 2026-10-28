import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { looksLikeAbbreviation, looksLikeUnknownWord, getAllowedAbbreviations } from "@/utils/englishWords";
import { objectRange } from "@/lib/openapi/sourceMap";
import type { SourceRange } from "@/types/openapi";
import { getSource } from "@/functions/common";
import type { NativeOperation, NativeParameterSchema } from "@/types/openapi";
import { isSwagger2Root } from "@/lib/openapi/media";
import { collectRequestExamples, collectResponseExamples } from "@/lib/openapi/examples";
import { namingSchemas, schemaNameFields } from "@/utils/nativeNaming";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";
import { ruleOperations, ruleParameterNodes, ruleRequest } from "@/utils/nativeRule";

export function checkCommonParameters(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const source = getSource(rule);

    if (!spec?.paths) return diagnostics;

    const reported = new Set<string>();
    const refCache = new Map<string, any>();

    const params = rule?.call?.functionParams ?? {};
    const methodsToCheck: string[] = Array.isArray(params.methods)
        ? params.methods.map((m: any) => String(m).trim().toLowerCase()).filter(Boolean)
        : [];

    const allowedNameArr: string[] = Array.isArray(params.allowedName) ? params.allowedName : [];
    const notAllowedArr: string[] = Array.isArray(params.notAllowedNames) ? params.notAllowedNames : [];

    const allowedNames = new Set<string>(allowedNameArr.map((s) => String(s).trim().toLowerCase()));
    const notAllowedNames = new Set<string>(notAllowedArr.map((s) => String(s).trim().toLowerCase()));

    const allowedAbbrevs = getAllowedAbbreviations();
    const tokenCache = new Map<string, string[]>();
    const suspiciousCache = new Map<string, { badTokens: string[]; reasons: string[] }>();

    function splitIdentifierToTokens(name: string): string[] {
        const key = String(name);
        const cached = tokenCache.get(key);
        if (cached) return cached;

        const base = key
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .toLowerCase();

        const tokens = base.split(/\s+/).filter(Boolean);
        tokenCache.set(key, tokens);
        return tokens;
    }

    function isSuspiciousName(name: string): { badTokens: string[]; reasons: string[] } {
        const key = String(name);
        const cached = suspiciousCache.get(key);
        if (cached) return cached;

        const badTokens: string[] = [];
        const reasons: string[] = [];

        const tokens = splitIdentifierToTokens(key);
        for (const t of tokens) {
            if (looksLikeAbbreviation(t, allowedAbbrevs)) {
                badTokens.push(t);
                reasons.push("uncommon abbreviation");
                continue;
            }
            if (looksLikeUnknownWord(t)) {
                badTokens.push(t);
                reasons.push("non-dictionary term");
            }
        }

        const result = { badTokens: Array.from(new Set(badTokens)), reasons: Array.from(new Set(reasons)) };
        suspiciousCache.set(key, result);
        return result;
    }

    function pushDiagnosticAtRange(from: number, to: number, msg: string, dedupeKey: string) {
        const key = `${source}|${dedupeKey}`;
        if (reported.has(key)) return;
        reported.add(key);

        diagnostics.push({
            from,
            to,
            severity: mapSeverity(rule.severity),
            message: msg,
            source,
        });
    }

    function evaluateName(nameRaw: string, range: SourceRange, dedupeContext?: string) {
        const name = String(nameRaw).trim().toLowerCase();
        if (!name) return;

        if (allowedNames.has(name)) {
            return;
        }

        if (notAllowedNames.has(name)) {
            const r = range;
            pushDiagnosticAtRange(
                r.from,
                r.to,
                `Parameter/property name "${nameRaw}" is not allowed. ${rule.message}`,
                `notAllowed|${dedupeContext ?? ""}|${name}`
            );
            return;
        }

        const suspicious = isSuspiciousName(nameRaw);
        if (suspicious.badTokens.length) {
            const r = range;
            pushDiagnosticAtRange(
                r.from,
                r.to,
                `Parameter/property name "${nameRaw}" may not follow common standard words (${suspicious.reasons.join(", ")}: ${suspicious.badTokens.join(", ")}). ${rule.message}`,
                `suspicious|${dedupeContext ?? ""}|${name}|${suspicious.badTokens.join("_")}`
            );
        }
    }

    function collectParameterNamesForOperation(op: NativeOperation) {
        const ctx = `${op.path}#${op.method}`;
        for (const { parameter } of ruleParameterNodes(op, spec, refCache)) {
            if (isSwagger2Root(spec) && parameter.in === "body") continue;
            if (typeof parameter.name !== "string") continue;
            evaluateName(parameter.name, objectRange(spec, content, parameter, "name", "value"), ctx);
        }
    }

    function schemaWalk(
        schema: NativeParameterSchema,
        visitor: (propName: string, owner: object) => void,
    ) {
        const examples: unknown[] = [];
        for (const field of schemaNameFields(schema, spec, refCache, {
            maps: true, compositionsFirst: true,
            visitSchema: ({ node }) => { if (Object.hasOwn(node, "example")) examples.push(node.example); },
        })) {
            visitor(field.name, field.owner);
        }
        return examples;
    }

    function exampleWalk(example: unknown, visitor: (propName: string, owner: object) => void) {
        type Frame = { value: unknown } | { name: string; owner: object; value: unknown };
        const pending: Frame[] = [{ value: example }];
        const seen = new WeakSet<object>();
        while (pending.length) {
            const frame = pending.pop()!;
            if ("name" in frame) visitor(frame.name, frame.owner);
            const value = frame.value;
            if (!value || typeof value !== "object" || seen.has(value)) continue;
            seen.add(value);
            if (Array.isArray(value)) {
                for (let index = value.length - 1; index >= 0; index--) pending.push({ value: value[index] });
            } else {
                const entries = Object.entries(value);
                for (let index = entries.length - 1; index >= 0; index--) {
                    const [name, child] = entries[index];
                    pending.push({ name, owner: value, value: child });
                }
            }
        }
    }

    function collectBodyAndResponseNames(op: NativeOperation) {
        const ctx = `${op.path}#${op.method}`;
        const visit = (name: string, owner: object) => evaluateName(name, objectRange(spec, content, owner, name), ctx);
        const request = ruleRequest(op, spec, refCache);
        const requestSchemaExamples = namingSchemas(request, spec, refCache, true).flatMap((schema) => schemaWalk(schema, visit));
        const exampleConfig = { exampleSources: {
            request: ["content.example", "content.examples"],
            response: ["content.example", "content.examples", "response.examples"],
        } };
        for (const entry of collectRequestExamples(op.operation, op.pathItem, spec, exampleConfig, refCache, {
            pathItem: op.resolvedPathItemPointer, operation: op.pointer,
        })) exampleWalk(entry.value, visit);
        for (const example of requestSchemaExamples) exampleWalk(example, visit);
        for (const status of responseStatuses(op)) {
            const response = responseFor(op, status, spec, refCache);
            const schemaExamples = namingSchemas(response, spec, refCache, true).flatMap((schema) => schemaWalk(schema, visit));
            for (const entry of collectResponseExamples(op.operation, [status], spec, exampleConfig, refCache, op.pointer)) {
                exampleWalk(entry.value, visit);
            }
            for (const example of schemaExamples) exampleWalk(example, visit);
        }
    }

    for (const op of ruleOperations(spec, methodsToCheck.length ? { methods: methodsToCheck } : {})) {
        collectParameterNamesForOperation(op);
        collectBodyAndResponseNames(op);
    }

    return diagnostics;
}
