import { operationRange, sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer } from "@/lib/openapi/references";

export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMethodPositionInYaml(content: string, path: string, method: string): { start: number; end: number } {
    const { from: start, to: end } = operationRange(content, path, method);
    return { start, end };
}

export function findMethodParametersPositionInYaml(content: string, path: string, method: string): { start: number; end: number } {
    const { from: start, to: end } = sourceMap(content).locate(jsonPointer(["paths", path, method, "parameters"]), "key", true);
    return { start, end };
}

export function findParameterPositionInYaml(content: string, path: string, method: string, paramName: string): { start: number; end: number } {
    const { from: start, to: end } = sourceMap(content).parameter(path, method, paramName);
    return { start, end };
}

export function violatingIndexRange(content: string, pointer: string): { from: number; to: number } {
    return sourceMap(content).locate(pointer);
}

export function findKeyRangeInContent(content: string, key: string, searchStart?: number): { from: number; to: number } {
    return sourceMap(content).findKey(key, searchStart);
}

export function findRequestBodyPositionInYaml(content: string, path: string, method: string): { start: number; end: number } {
    const { from: start, to: end } = sourceMap(content).requestBody(path, method);
    return { start, end };
}
