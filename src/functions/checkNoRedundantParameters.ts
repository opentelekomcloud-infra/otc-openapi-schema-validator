import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { findMethodPositionInYaml } from "@/utils/pos";
import { resolveRefDeep } from "@/utils/schema";
import { dedupeDiagnostics } from "@/utils/diagnostic";
import {collectOperations} from "@/utils/spec";

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

/**
 * Collects path-item and operation-level parameters.
 */
function collectParameterDescriptors(pathItem: any, operation: any, spec: any, cfg: RedundancyConfig): FieldDescriptor[] {
    const descriptors: FieldDescriptor[] = [];
    const reservedFieldName = String(cfg.reservedFieldName ?? "x-reserved");
    const allParams = [
        ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
    ];

    for (const rawParam of allParams) {
        const param = resolveRefDeep(rawParam, new Map<string, any>(), spec);
        if (!param || typeof param !== "object") continue;

        const name = String((param as any).name ?? "").trim();
        const description = String((param as any).description ?? "").trim();
        const scope = String((param as any).in ?? "").trim().toLowerCase();
        if (!name || !scope) continue;

        descriptors.push({
            name,
            description,
            reserved: Boolean((param as any)[reservedFieldName]),
            container: "parameters",
            scope,
        });
    }

    return descriptors;
}

/**
 * Collects only top-level request body properties from the resolved schema.
 */
function collectRequestBodyDescriptors(operation: any, spec: any, cfg: RedundancyConfig): FieldDescriptor[] {
    const descriptors: FieldDescriptor[] = [];
    const reservedFieldName = String(cfg.reservedFieldName ?? "x-reserved");
    const contentObj = operation?.requestBody?.content;
    if (!contentObj || typeof contentObj !== "object") return descriptors;

    const firstMediaType = Object.keys(contentObj)[0];
    const schema = resolveRefDeep(contentObj?.["application/json"]?.schema, new Map<string, any>(), spec)
        ?? resolveRefDeep(contentObj?.[firstMediaType]?.schema, new Map<string, any>(), spec);
    const props = schema?.properties;
    if (!props || typeof props !== "object") return descriptors;

    for (const [name, rawField] of Object.entries(props)) {
        const field = resolveRefDeep(rawField, new Map<string, any>(), spec);
        if (!field || typeof field !== "object") continue;

        descriptors.push({
            name: String(name),
            description: String((field as any).description ?? "").trim(),
            reserved: Boolean((field as any)[reservedFieldName]),
            container: "requestBody",
        });
    }

    return descriptors;
}

/**
 * Collects only top-level response properties from resolved response schemas.
 */
function collectResponseDescriptors(operation: any, spec: any, cfg: RedundancyConfig): FieldDescriptor[] {
    const descriptors: FieldDescriptor[] = [];
    const reservedFieldName = String(cfg.reservedFieldName ?? "x-reserved");
    const responses = operation?.responses;
    if (!responses || typeof responses !== "object") return descriptors;

    for (const code of Object.keys(responses)) {
        const response = resolveRefDeep(responses[code], new Map<string, any>(), spec);
        const contentObj = response?.content;
        if (!contentObj || typeof contentObj !== "object") continue;

        const firstMediaType = Object.keys(contentObj)[0];
        const schema = resolveRefDeep(contentObj?.["application/json"]?.schema, new Map<string, any>(), spec)
            ?? resolveRefDeep(contentObj?.[firstMediaType]?.schema, new Map<string, any>(), spec);
        const props = schema?.properties;
        if (!props || typeof props !== "object") continue;

        for (const [name, rawField] of Object.entries(props)) {
            const field = resolveRefDeep(rawField, new Map<string, any>(), spec);
            if (!field || typeof field !== "object") continue;

            descriptors.push({
                name: String(name),
                description: String((field as any).description ?? "").trim(),
                reserved: Boolean((field as any)[reservedFieldName]),
                container: `responses:${code}`,
            });
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
    const operations = collectOperations(spec);
    for (const { path, method, operation, pathItem } of operations) {
        const parameterFields = collectParameterDescriptors(pathItem, operation, spec, cfg);
        const requestFields = collectRequestBodyDescriptors(operation, spec, cfg);
        const responseFields = collectResponseDescriptors(operation, spec, cfg);

        const problems = [
            ...checkReservedMarkers(parameterFields, cfg),
            ...checkReservedMarkers(requestFields, cfg),
            ...checkReservedMarkers(responseFields, cfg),
            ...checkDuplicates(parameterFields, cfg),
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
