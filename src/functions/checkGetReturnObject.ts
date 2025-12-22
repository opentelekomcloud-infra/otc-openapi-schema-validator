import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";
import {getSource} from "@/functions/common";

export function checkGetReturnObject(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec?.paths) return diagnostics;

    const method = rule.call.functionParams.method;
    const requiredResponseType = rule.call.functionParams.requiredResponseType;
    const requiredPathRegexp = rule.call.functionParams.requiredPathRegexp;
    const exceptionPathRegexp = rule.call.functionParams.exceptionPathRegexp || "";

    const exceptionPatterns: RegExp[] = Array.isArray(exceptionPathRegexp)
        ? exceptionPathRegexp.map((r: string) => new RegExp(r))
        : [];

    const requiredPatterns: RegExp[] = Array.isArray(requiredPathRegexp)
        ? requiredPathRegexp.map((r: string) => new RegExp(r))
        : [];

    const resolveRef = (schemaLike: any): any => {
        let schema = schemaLike;
        if (schema?.["$ref"]) {
            const refPath = schema["$ref"].slice(2).split("/");
            let resolved: any = spec;
            for (const part of refPath) {
                if (resolved instanceof Map) {
                    resolved = resolved.get(part);
                } else if (typeof resolved === "object" && resolved !== null) {
                    resolved = resolved[part];
                } else {
                    resolved = undefined;
                    break;
                }
            }
            schema = resolved;
        }
        return schema;
    };

    const isArrayLikeWrapperObject = (schema: any): boolean => {
        if (!schema || schema.type !== "object") return false;
        const props = schema.properties;
        if (!props || typeof props !== "object") return false;

        const hasPagingMeta =
            Object.prototype.hasOwnProperty.call(props, "page") ||
            Object.prototype.hasOwnProperty.call(props, "page_info") ||
            Object.prototype.hasOwnProperty.call(props, "count");

        const entries = Object.entries(props);
        if (entries.length === 0) return false;

        const anyArrayProp = entries.some(([, v]) => {
            const s = resolveRef(v);
            return s?.type === "array";
        });

        const firstPropIsArray = (() => {
            const first = entries[0]?.[1];
            const s = resolveRef(first);
            return s?.type === "array";
        })();

        // Accept as "array-like" if it looks like a paged-list wrapper and has an array payload,
        // OR if the first property itself is an array (common wrapper pattern).
        return (hasPagingMeta && anyArrayProp) || firstPropIsArray;
    };

    const matchesRequiredType = (schemaLike: any): boolean => {
        const schema = resolveRef(schemaLike);
        if (!schema) return false;

        if (requiredResponseType === "array") {
            if (schema.type === "array") return true;
            if (schema.type === "object" && isArrayLikeWrapperObject(schema)) return true;
            return false;
        }

        return schema.type === requiredResponseType;
    };

    for (const path in spec.paths) {
        if (exceptionPatterns.some(re => re.test(path))) continue;
        if (!requiredPatterns.some(re => re.test(path))) continue;

        const pathItem = spec.paths[path];
        const operation = pathItem[method];
        if (!operation || typeof operation !== "object") continue;

        const responses = operation.responses;
        if (!responses || typeof responses !== "object") continue;

        for (const statusCode in responses) {
            if (!/^2\d{2}$/.test(statusCode)) continue;

            const response = responses[statusCode];
            const contentEntry = response?.content;
            if (!contentEntry || typeof contentEntry !== "object") continue;

            for (const mediaType in contentEntry) {
                const media = contentEntry[mediaType];
                let schema = media.schema;

                schema = resolveRef(schema);

                if (schema?.oneOf || schema?.anyOf) {
                    const variants = schema.oneOf || schema.anyOf;
                    for (const variant of variants) {
                        if (!matchesRequiredType(variant)) {
                            const { start, end } = findMethodPositionInYaml(content, path, method);
                            diagnostics.push({
                                from: start,
                                to: end,
                                severity: mapSeverity(rule.severity),
                                message: rule.message,
                                source: getSource(rule),
                            });
                            break;
                        }
                    }
                } else if (!schema || !matchesRequiredType(schema)) {
                    let fallbackAllowed = false;
                    if (
                        rule.id === "STC-010-01-2507-2507-M-5" &&
                        schema?.type === "object" &&
                        Array.isArray(schema.required)
                    ) {
                        fallbackAllowed = schema.required.some((field: string) => field.endsWith("s"));
                    }

                    if (!fallbackAllowed) {
                        const { start, end } = findMethodPositionInYaml(content, path, method);
                        diagnostics.push({
                            from: start,
                            to: end,
                            severity: mapSeverity(rule.severity),
                            message: rule.message,
                            source: getSource(rule),
                        });
                    }
                }
            }
        }
    }

    return diagnostics;
}
