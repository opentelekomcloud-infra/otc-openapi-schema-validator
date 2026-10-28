import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { findMethodPositionInYaml } from "@/utils/pos";
import { dedupeDiagnostics } from "@/utils/diagnostic";
import type { NativeOperation } from "@/types/openapi";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { isSwagger2Root } from "@/lib/openapi/media";
import { resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";
import { declaredParameterGroups, namingSchemas, rootSchemaFields } from "@/utils/nativeNaming";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";
import { ruleOperations, ruleParameterNodes, ruleRequest } from "@/utils/nativeRule";

type RedundancyConfig = {
    checkReservedMarkerForUnused?: boolean;
    reservedFieldName?: string;
    reservedDescriptionRequired?: boolean;
    checkDuplicateNamesWithinSameContainer?: boolean;
    semanticDuplicateDetectionMode?: string;
    minDescriptionSimilarityThreshold?: number;
    compareScopesSeparately?: boolean;
};

type FieldDescriptor = {
    name: string;
    description: string;
    reserved: boolean;
    container: string;
    scope?: string;
};

/**
 * Normalizes free-text description for rough semantic comparison.
 */
function normalizeDescription(text: string): string {
    return String(text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Computes a simple token-overlap similarity in range [0, 1].
 */
function computeDescriptionSimilarity(a: string, b: string): number {
    const aTokens = new Set(normalizeDescription(a).split(" ").filter(Boolean));
    const bTokens = new Set(normalizeDescription(b).split(" ").filter(Boolean));

    if (aTokens.size === 0 || bTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) intersection += 1;
    }

    const denominator = Math.max(aTokens.size, bTokens.size);
    return denominator === 0 ? 0 : intersection / denominator;
}

/**
 * Heuristic for fields that look like placeholders or unused reserved fields.
 */
function looksUnused(name: string, description: string): boolean {
    const combined = `${name} ${description}`.toLowerCase();
    return ["reserved", "future", "unused", "not used", "for future use", "placeholder"].some((t) => combined.includes(t));
}

function parameterField(param: Record<string, unknown>, spec: unknown, cfg: RedundancyConfig): FieldDescriptor | undefined {
    if (isSwagger2Root(spec) && param.in === "body") return undefined;
    const reservedFieldName = String(cfg.reservedFieldName ?? "x-reserved");
    const form = isSwagger2Root(spec) && param.in === "formData";
    return {
        name: String(param.name ?? "").trim(),
        description: String(param.description ?? "").trim(),
        reserved: Boolean(param[reservedFieldName]),
        container: form ? "requestBody" : "parameters",
        scope: form ? undefined : String(param.in ?? "").trim().toLowerCase(),
    };
}

function propertyFields(
    fields: ReturnType<typeof rootSchemaFields>, container: string, spec: unknown, cfg: RedundancyConfig, cache: ReferenceCache,
): FieldDescriptor[] {
    const reservedFieldName = String(cfg.reservedFieldName ?? "x-reserved");
    return fields.map((field) => {
        const resolved = resolveObjectReference(field.node, spec, cache, field.pointer);
        if (!resolved) throw new NativeAccessorError("INVALID_SCHEMA", field.pointer, "Expected a property schema");
        return {
            name: field.name, description: String(resolved.value.description ?? "").trim(),
            reserved: Boolean(resolved.value[reservedFieldName]), container,
        };
    });
}

/**
 * Collects only top-level request body properties from the resolved schema.
 */
function collectRequestBodyDescriptors(op: NativeOperation, spec: unknown, cfg: RedundancyConfig, cache: ReferenceCache): FieldDescriptor[] {
    const payload = ruleRequest(op, spec, cache);
    if (payload.kind === "formData") {
        return payload.fields.flatMap(({ parameter }) => {
            const field = parameterField(parameter, spec, cfg);
            return field ? [field] : [];
        });
    }
    return namingSchemas(payload, spec, cache).flatMap((schema) =>
        propertyFields(rootSchemaFields(schema, spec, cache), "requestBody", spec, cfg, cache));
}

/**
 * Collects only top-level response properties from resolved response schemas.
 */
function collectResponseDescriptors(op: NativeOperation, spec: unknown, cfg: RedundancyConfig, cache: ReferenceCache): FieldDescriptor[] {
    const descriptors: FieldDescriptor[] = [];
    for (const code of responseStatuses(op)) {
        for (const schema of namingSchemas(responseFor(op, code, spec, cache), spec, cache)) {
            descriptors.push(...propertyFields(rootSchemaFields(schema, spec, cache), `responses:${code}`, spec, cfg, cache));
        }
    }

    return descriptors;
}

/**
 * Checks reserved/unused field documentation.
 */
function checkReservedMarkers(fields: FieldDescriptor[], cfg: RedundancyConfig): string[] {
    const problems: string[] = [];

    if (!cfg.checkReservedMarkerForUnused) return problems;

    for (const field of fields) {
        if (!looksUnused(field.name, field.description)) continue;

        if (!field.reserved) {
            problems.push(`Field '${field.name}' in ${field.container}${field.scope ? ` (${field.scope})` : ""} looks reserved/unused but is missing '${cfg.reservedFieldName ?? "x-reserved"}: true'.`);
            continue;
        }

        if (cfg.reservedDescriptionRequired && !field.description) {
            problems.push(`Field '${field.name}' in ${field.container}${field.scope ? ` (${field.scope})` : ""} is marked reserved but must also provide description.`);
        }
    }

    return problems;
}

/**
 * Checks duplicate names and rough duplicate semantics inside the same container.
 */
function checkDuplicates(fields: FieldDescriptor[], cfg: RedundancyConfig): string[] {
    const problems: string[] = [];
    if (!cfg.checkDuplicateNamesWithinSameContainer) return problems;

    const threshold = Number(cfg.minDescriptionSimilarityThreshold ?? 0.85);
    const byGroup = new Map<string, FieldDescriptor[]>();

    for (const field of fields) {
        const groupKey = cfg.compareScopesSeparately
            ? `${field.container}:${field.scope ?? "none"}`
            : field.container;
        const current = byGroup.get(groupKey) ?? [];
        current.push(field);
        byGroup.set(groupKey, current);
    }

    for (const [, group] of byGroup) {
        for (let i = 0; i < group.length; i += 1) {
            for (let j = i + 1; j < group.length; j += 1) {
                const left = group[i];
                const right = group[j];

                if (left.name === right.name) {
                    problems.push(`Duplicate field name '${left.name}' found in ${left.container}${left.scope ? ` (${left.scope})` : ""}.`);
                    continue;
                }

                if (String(cfg.semanticDuplicateDetectionMode ?? "") !== "descriptionBased") continue;
                if (!left.description || !right.description) continue;
                if (left.description.length < 10 || right.description.length < 10) continue;

                const similarity = computeDescriptionSimilarity(left.description, right.description);
                if (similarity >= threshold) {
                    problems.push(`Fields '${left.name}' and '${right.name}' in ${left.container}${left.scope ? ` (${left.scope})` : ""} appear to duplicate semantics based on description similarity (${similarity.toFixed(2)}).`);
                }
            }
        }
    }

    return problems;
}

/**
 * ARG-050-01-2507-2507-O
 * Reserved and Redundant Parameter Design.
 *
 * Implementation covers:
 * - reserved/unused fields must carry x-reserved marker and description when applicable
 * - duplicate names inside the same container
 * - rough semantic duplicates based on description similarity inside the same container
 *
 * Scope comparison is kept separate for parameters when configured.
 */
export function checkNoRedundantParameters(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec?.paths) {
        return diagnostics;
    }

    const cfg = (rule?.call?.functionParams ?? {}) as RedundancyConfig;
    const cache = new Map<string, unknown>();
    for (const op of ruleOperations(spec, {})) {
        const { path, method } = op;
        const parameterFields = ruleParameterNodes(op, spec, cache).flatMap(({ parameter }) => {
            const field = parameterField(parameter, spec, cfg);
            return field?.container === "parameters" ? [field] : [];
        });
        const requestFields = collectRequestBodyDescriptors(op, spec, cfg, cache);
        const responseFields = collectResponseDescriptors(op, spec, cfg, cache);
        const declarationDuplicates = declaredParameterGroups(op, spec, cache).flatMap((group) =>
            checkDuplicates(group.flatMap((parameter) => {
                const field = parameterField(parameter, spec, cfg);
                return field ? [field] : [];
            }), { ...cfg, semanticDuplicateDetectionMode: "none" }));

        const problems = [
            ...checkReservedMarkers(parameterFields, cfg),
            ...checkReservedMarkers(requestFields, cfg),
            ...checkReservedMarkers(responseFields, cfg),
            ...checkDuplicates(parameterFields, cfg),
            ...declarationDuplicates,
            ...checkDuplicates(requestFields, cfg),
            ...checkDuplicates(responseFields, cfg),
        ];

        for (const problem of problems) {
            const { start, end } = findMethodPositionInYaml(content, path, method);
            diagnostics.push({
                from: start,
                to: end,
                severity: mapSeverity(rule.severity),
                message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message} ${problem}`,
                source: getSource(rule),
            });
        }
    }

    return dedupeDiagnostics(diagnostics);
}
