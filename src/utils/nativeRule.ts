import type { Diagnostic } from "@codemirror/lint";
import type { AutoRule } from "@/lib/linter/ruleCatalog";
import type { NativeOperation, NativeParameter } from "@/types/openapi";
import { getSource } from "@/functions/common";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { isStringList, isSwagger2Root } from "@/lib/openapi/media";
import { collectParameterDescriptors, collectEffectiveParameterNodes } from "@/lib/openapi/parameters";
import { getRequestPayload } from "@/lib/openapi/payloads";
import { collectDocumentOperations } from "@/lib/openapi/operations";
import { collectDocumentPathEntries } from "@/lib/openapi/paths";
import { isDocumentObject } from "@/lib/openapi/parseNativeOpenApi";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { mapSeverity } from "@/utils/mapSeverity";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";
import { matchParameterSchema } from "@/utils/schema";

export type NativeRule = Pick<AutoRule, "id" | "title" | "message" | "severity" | "call"> & {
    readonly element?: unknown;
};

export function ruleStrings(value: unknown, field: string): readonly string[] {
    if (value === undefined) return [];
    if (!isStringList(value)) throw new Error(`functionParams.${field} must be an array of strings.`);
    return value;
}

export function ruleDocument(spec: unknown): Record<string, unknown> {
    if (!isDocumentObject(spec)) throw new NativeAccessorError("INVALID_DECLARATION", "#", "Expected a specification object");
    if (spec.paths !== undefined && !isRecord(spec.paths)) {
        throw new NativeAccessorError("INVALID_DECLARATION", "#/paths", "Expected a paths object");
    }
    return spec;
}

export function ruleOperations(
    spec: unknown, params: Record<string, unknown>, pathFilter?: (path: string) => boolean,
): NativeOperation[] {
    return collectDocumentOperations(ruleDocument(spec),
        params.methods === undefined ? undefined : ruleStrings(params.methods, "methods"), pathFilter);
}

export function rulePathKeys(spec: unknown): string[] {
    return collectDocumentPathEntries(ruleDocument(spec)).map(([path]) => path);
}

function validateParameterLists(op: NativeOperation, spec: unknown, cache: ReferenceCache): void {
    for (const [parent, pointer] of [[op.pathItem, op.resolvedPathItemPointer], [op.operation, op.pointer]] as const) {
        if (parent.parameters === undefined) continue;
        const source = appendPointer(pointer, "parameters");
        if (!Array.isArray(parent.parameters)) {
            throw new NativeAccessorError("INVALID_DECLARATION", source, "Expected a parameters array");
        }
        parent.parameters.forEach((raw: unknown, index: number) => {
            const position = appendPointer(source, index);
            const target = resolveObjectReference(raw, spec, cache, position);
            if (!target || typeof target.value.name !== "string" || !target.value.name ||
                typeof target.value.in !== "string" || !target.value.in) {
                throw new NativeAccessorError("INVALID_DECLARATION", position, "Expected a parameter with name and in");
            }
        });
    }
}

export function ruleParameterNodes(op: NativeOperation, spec: unknown, cache: ReferenceCache) {
    validateParameterLists(op, spec, cache);
    return collectEffectiveParameterNodes(op.pathItem, op.operation, spec, cache,
        { pathItem: op.resolvedPathItemPointer, operation: op.pointer });
}

export function ruleParameters(op: NativeOperation, spec: unknown, cache: ReferenceCache): NativeParameter[] {
    validateParameterLists(op, spec, cache);
    return collectParameterDescriptors(op.pathItem, op.operation, spec, cache,
        { pathItem: op.resolvedPathItemPointer, operation: op.pointer });
}

export function ruleRequest(op: NativeOperation, spec: unknown, cache: ReferenceCache) {
    if (isSwagger2Root(spec)) validateParameterLists(op, spec, cache);
    return getRequestPayload(op.operation, op.pathItem, spec, cache,
        { pathItem: op.resolvedPathItemPointer, operation: op.pointer });
}

export function ruleDiagnostic(
    content: string, rule: NativeRule, pointer: string, details = "", kind: "key" | "value" = "key",
): Diagnostic {
    return {
        ...sourceMap(content).locate(pointer, kind),
        severity: mapSeverity(rule.severity),
        message: details ? `${rule.message} ${details}` : rule.message,
        source: getSource(rule),
    };
}

export interface ParameterExpectation {
    readonly name: string;
    readonly in: string;
    readonly valueType?: string;
    readonly required?: boolean;
    readonly description?: boolean;
    readonly style?: string;
}

export function parameterExpectations(value: unknown, field: string): ParameterExpectation[] {
    if (!Array.isArray(value)) throw new Error(`functionParams.${field} must be an array of parameter expectations.`);
    return value.map((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name ||
            typeof entry.in !== "string" || !entry.in ||
            (entry.valueType !== undefined && typeof entry.valueType !== "string") ||
            (entry.required !== undefined && typeof entry.required !== "boolean") ||
            (entry.description !== undefined && typeof entry.description !== "boolean") ||
            (entry.style !== undefined && typeof entry.style !== "string")) {
            throw new Error(`Invalid parameter expectation in functionParams.${field}.`);
        }
        return {
            name: entry.name, in: entry.in, valueType: entry.valueType,
            required: entry.required, description: entry.description, style: entry.style,
        };
    });
}

export function parameterMatches(param: NativeParameter, expected: ParameterExpectation, spec: unknown): boolean {
    return matchParameterSchema(param.parameter, expected.name, expected.in, expected.valueType, spec, {
        required: expected.required, description: expected.description, style: expected.style,
    });
}
