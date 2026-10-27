import type { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { getSource } from "@/functions/common";
import { nativeBaseline, readBaseline } from "@/lib/openapi/baseline";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import { getNativeRequest, getNativeResponse } from "@/lib/openapi/payloads";
import { pathRange } from "@/lib/openapi/sourceMap";
import { isRecord } from "@/lib/openapi/references";
import {
    comparisonOperations, compatibilityShape, responseCodes, responseHeaders, type CompatibilityShape,
} from "@/utils/nativeCompatibility";

export async function checkCompatibility(spec: unknown, content: string, rule: any): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const current = classifyNativeOpenApiDocument(spec);
    const baseline = await nativeBaseline(spec);
    const methods = rule.id === "BAS-080-01-2507-2507-M" ? rule.call.functionParams.methods : undefined;
    const before = readBaseline(() => comparisonOperations(baseline, methods));
    const after = comparisonOperations(current, methods, new Set([...before.values()].map((operation) => operation.path)));
    const baseCache = new Map<string, unknown>();
    const currentCache = new Map<string, unknown>();
    const elements = typeof rule.element === "string" ? [rule.element] : Array.isArray(rule.element) ? rule.element : [];
    const report = (path: string, message: string) => diagnostics.push({
        ...pathRange(content, path), severity: mapSeverity(rule.severity), message, source: getSource(rule),
    });
    const missingPaths = new Set<string>();

    for (const [key, baseOperation] of before) {
        const operation = after.get(key);
        const { path, method } = baseOperation;
        const methodName = method.toUpperCase();
        if (rule.id === "BAS-080-01-2507-2507-M") {
            if (!operation) {
                const hasPath = isRecord(current.document.paths) && Object.hasOwn(current.document.paths, path);
                if (hasPath) report(path, `${methodName} method at path "${path}" was deleted in the new spec.`);
                else if (!missingPaths.has(path)) {
                    missingPaths.add(path);
                    report(path, `Path "${path}" was deleted in the new spec.`);
                }
            }
            continue;
        }
        if (!operation) continue;

        const compare = (oldShape: CompatibilityShape | undefined, newShape: CompatibilityShape | undefined, code?: string) => {
            if (!oldShape || !newShape) return;
            const response = code !== undefined;
            if (rule.id === "BAS-080-01-2507-2507-M-1") {
                for (const property of oldShape.properties) {
                    if (newShape.properties.has(property)) continue;
                    report(path, response
                        ? `Response property "${property}" in code ${code} was deleted in method ${methodName} at path "${path}".`
                        : `Request body property "${property}" was deleted in method ${methodName} at path "${path}".`);
                }
            } else if (rule.id === "BAS-080-01-2507-2507-M-2" && !response) {
                for (const property of newShape.properties) {
                    if (!oldShape.properties.has(property)) {
                        report(path, `Request body property "${property}" was added in method ${methodName} at path "${path}".`);
                    }
                }
            } else if (rule.id === "BAS-080-01-2507-2507-M-3") {
                for (const [property, oldType] of oldShape.types) {
                    const newType = newShape.types.get(property);
                    if (newType === undefined || newType === oldType) continue;
                    report(path, response
                        ? `Type of response property "${property}" (code ${code}) changed from "${oldType}" to "${newType}" in method ${methodName} at path "${path}".`
                        : `Type of request body property "${property}" changed from "${oldType}" to "${newType}" in method ${methodName} at path "${path}".`);
                }
            } else if (rule.id === "BAS-080-01-2507-2507-M-4") {
                for (const [property, oldValues] of oldShape.enums) {
                    const newValues = newShape.enums.get(property);
                    if (!newValues) continue;
                    const removed = [...oldValues].filter((value) => !newValues.has(value));
                    if (!removed.length) continue;
                    report(path, response
                        ? `Enum values removed for response property "${property}" (code ${code}) in ${methodName} ${path}: ${removed.join(", ")}.`
                        : `Enum values removed for request body property "${property}" in ${methodName} ${path}: ${removed.join(", ")}.`);
                }
            }
        };

        if (elements.includes("requestBody") && !["BAS-080-01-2507-2507-M-5", "BAS-080-01-2507-2507-M-6"].includes(rule.id)) {
            compare(readBaseline(() => compatibilityShape(getNativeRequest(baseline, baseOperation, baseCache), baseline, baseCache)),
                compatibilityShape(getNativeRequest(current, operation, currentCache), current, currentCache));
        }
        if (!elements.includes("responses") || rule.id === "BAS-080-01-2507-2507-M-2") continue;
        const currentCodes = new Set(responseCodes(operation));
        for (const code of readBaseline(() => responseCodes(baseOperation))) {
            if (rule.id === "BAS-080-01-2507-2507-M-5") {
                if (!currentCodes.has(code)) report(path, `Response code ${code} was deleted in method ${methodName} at path "${path}".`);
                continue;
            }
            if (!currentCodes.has(code)) continue;
            if (rule.id === "BAS-080-01-2507-2507-M-6") {
                const oldHeaders = readBaseline(() => responseHeaders(baseline, baseOperation, code, baseCache));
                const newHeaders = responseHeaders(current, operation, code, currentCache);
                for (const header of oldHeaders) {
                    if (!newHeaders.has(header)) report(path,
                        `Response header "${header}" was deleted for code ${code} in ${methodName} at path "${path}".`);
                }
                for (const header of newHeaders) {
                    if (!oldHeaders.has(header)) report(path,
                        `Response header "${header}" was added for code ${code} in ${methodName} at path "${path}".`);
                }
            } else {
                compare(readBaseline(() => compatibilityShape(getNativeResponse(baseline, baseOperation, code, baseCache), baseline, baseCache)),
                    compatibilityShape(getNativeResponse(current, operation, code, currentCache), current, currentCache), code);
            }
        }
    }
    return diagnostics;
}
