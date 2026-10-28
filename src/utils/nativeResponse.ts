import type { NativeOperation, NativeResponsePayload } from "@/types/openapi";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { getResponsePayload, selectPayloadSchema } from "@/lib/openapi/payloads";
import { appendPointer, isRecord, resolveObjectReference, type ReferenceCache } from "@/lib/openapi/references";

export function responseFor(op: NativeOperation, status: string, spec: unknown, cache: ReferenceCache) {
    if (op.operation.responses === undefined) return undefined;
    if (!isRecord(op.operation.responses)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(op.pointer, "responses"), "Expected a responses object");
    }
    return getResponsePayload(op.operation, status, spec, cache, op.pointer);
}

export function responseStatuses(op: NativeOperation): string[] {
    if (op.operation.responses === undefined) return [];
    if (!isRecord(op.operation.responses)) {
        throw new NativeAccessorError("INVALID_DECLARATION", appendPointer(op.pointer, "responses"), "Expected a responses object");
    }
    return Object.keys(op.operation.responses).filter((status) => !status.startsWith("x-"));
}

export function selectedResponseSchema(payload: NativeResponsePayload, spec: unknown, cache: ReferenceCache) {
    return selectPayloadSchema(payload, ["application/json"], spec, cache);
}

export function schemaRecord(value: unknown, spec: unknown, cache: ReferenceCache, pointer = "#") {
    return isRecord(value) ? resolveObjectReference(value, spec, cache, pointer)?.value : undefined;
}

export function responseVariants(schema: Record<string, unknown>, pointer: string): Record<string, unknown>[] {
    const key = Object.hasOwn(schema, "oneOf") ? "oneOf" : Object.hasOwn(schema, "anyOf") ? "anyOf" : undefined;
    if (!key) return [schema];
    const variants = schema[key];
    if (!Array.isArray(variants) || !variants.length || !variants.every(isRecord)) {
        throw new NativeAccessorError("INVALID_SCHEMA", appendPointer(pointer, key), `Expected non-empty ${key} schema objects`);
    }
    return variants;
}

export function configuredString(value: unknown, name: string, fallback?: string): string {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string" || !value) throw new Error(`functionParams.${name} must be a non-empty string.`);
    return value;
}

export function configuredBoolean(value: unknown, name: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`functionParams.${name} must be a boolean.`);
    return value;
}

export function configuredStatus(value: unknown): string {
    if (typeof value === "number" && Number.isInteger(value)) return String(value);
    return configuredString(value, "responseCode", "200");
}
