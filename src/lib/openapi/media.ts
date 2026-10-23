import type { NativeStringList } from "@/types/openapi";
import { NativeAccessorError } from "./accessorError";
import { appendPointer, isRecord } from "./references";

export function isSwagger2Root(document: unknown): boolean {
    return isRecord(document) && (document.swagger === "2.0" || document.swagger === 2);
}

export function hasOwnField(value: unknown, key: string): value is Record<string, unknown> {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

export function isStringList(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

export function getEffectiveStringList(
    document: unknown, operation: unknown, field: "consumes" | "produces" | "schemes", operationPointer = "#",
): NativeStringList {
    for (const { parent, pointer, level } of [
        { parent: operation, pointer: operationPointer, level: "operation" as const },
        { parent: document, pointer: "#", level: "root" as const },
    ]) {
        if (!hasOwnField(parent, field)) continue;
        const value = parent[field];
        const sourcePointer = appendPointer(pointer, field);
        if (!isStringList(value)) {
            throw new NativeAccessorError("INVALID_DECLARATION", sourcePointer, `Expected a ${field} string array`);
        }
        return { state: "declared", values: value, node: value, pointer: sourcePointer, level };
    }
    return { state: "unspecified", values: [] };
}
