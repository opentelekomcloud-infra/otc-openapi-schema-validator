import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { findMethodPositionInYaml } from "@/utils/pos";

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

                if (schema?.["$ref"]) {
                    const refPath = schema["$ref"].slice(2).split("/");
                    let resolved = spec;
                    for (const part of refPath) {
                        if (resolved instanceof Map) {
                            resolved = resolved.get(part);
                        } else if (typeof resolved === "object") {
                            resolved = resolved[part];
                        }
                    }
                    schema = resolved;
                }

                if (schema?.oneOf || schema?.anyOf) {
                    const variants = schema.oneOf || schema.anyOf;
                    for (const variant of variants) {
                        if (variant?.["$ref"]) {
                            const refPath = variant["$ref"].slice(2).split("/");
                            let resolved = spec;
                            for (const part of refPath) {
                                if (resolved instanceof Map) {
                                    resolved = resolved.get(part);
                                } else if (typeof resolved === "object") {
                                    resolved = resolved[part];
                                }
                            }
                            if (resolved?.type !== requiredResponseType) {
                                const { start, end } = findMethodPositionInYaml(content, path, method);
                                diagnostics.push({
                                    from: start,
                                    to: end,
                                    severity: mapSeverity(rule.severity),
                                    message: rule.message,
                                    source: rule.id,
                                });
                                break;
                            }
                        } else if (variant?.type !== requiredResponseType) {
                            const { start, end } = findMethodPositionInYaml(content, path, method);
                            diagnostics.push({
                                from: start,
                                to: end,
                                severity: mapSeverity(rule.severity),
                                message: rule.message,
                                source: rule.id,
                            });
                            break;
                        }
                    }
                } else if (!schema || schema.type !== requiredResponseType) {
                    let fallbackAllowed = false;
                    if (
                        rule.id === "2.4.1.5" &&
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
                            source: rule.id,
                        });
                    }
                }
            }
        }
    }

    return diagnostics;
}
