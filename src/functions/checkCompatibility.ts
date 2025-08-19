import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { resolveRef, extractAllProperties, extractPropertyTypes, extractEnumIfExist } from "@/utils/schema";

const remoteSpecCache: Record<string, any> = {};



function checkDeletedApi(remoteSpec: any, spec: any, content: string, diagnostics: Diagnostic[], rule: any) {
    const allowedMethods = rule.call.functionParams.methods.map((m: string) => m.toLowerCase());
    for (const pathKey in remoteSpec.paths) {
        const remotePathItem = remoteSpec.paths[pathKey];
        const currentPathItem = spec.paths[pathKey];

        if (!currentPathItem) {
            const index = content.indexOf(pathKey);
            const start = index >= 0 ? index : 0;
            const end = start + pathKey.length;

            diagnostics.push({
                from: start,
                to: end,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" was deleted in the new spec.`,
                source: rule.id,
            });

            continue;
        }

        for (const method of allowedMethods) {
            const remoteOperation = remotePathItem[method];
            const currentOperation = currentPathItem[method];

            if (remoteOperation && !currentOperation) {
                const index = content.indexOf(pathKey);
                const start = index >= 0 ? index : 0;
                const end = start + pathKey.length;

                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: `${method.toUpperCase()} method at path "${pathKey}" was deleted in the new spec.`,
                    source: rule.id,
                });
            }
        }
    }
}

function checkEnumDecrease(remoteSpec: any, spec: any, content: string, diagnostics: Diagnostic[], rule: any) {
    const elements: string[] = rule?.element ?? [];
    if (!elements.length) return;

    for (const pathKey in remoteSpec.paths) {
        const remotePathItem = remoteSpec.paths[pathKey];
        const currentPathItem = spec.paths[pathKey];
        if (!currentPathItem) continue;

        for (const method in remotePathItem) {
            const remoteOp = remotePathItem[method];
            const currentOp = currentPathItem[method];
            if (!currentOp) continue;

            // Compare request body schema types
            if (elements.includes("requestBody")) {
                const remoteSchemaRef = remoteOp?.requestBody?.content?.["application/json"]?.schema;
                const currentSchemaRef = currentOp?.requestBody?.content?.["application/json"]?.schema;
                const remoteSchema = remoteSchemaRef?.$ref ? resolveRef(remoteSchemaRef.$ref, remoteSpec) : remoteSchemaRef;
                const currentSchema = currentSchemaRef?.$ref ? resolveRef(currentSchemaRef.$ref, spec) : currentSchemaRef;

                if (remoteSchema && currentSchema) {
                    const remoteEnums = extractEnumIfExist(remoteSchema, remoteSpec);
                    const currentEnums = extractEnumIfExist(currentSchema, spec);

                    for (const [propPath, oldSet] of remoteEnums.entries()) {
                        const newSet = currentEnums.get(propPath);
                        if (!newSet) continue; // no enum now; out of scope for this rule
                        const removed: string[] = [];
                        for (const v of oldSet) if (!newSet.has(v)) removed.push(v);
                        if (removed.length) {
                            const index = content.indexOf(pathKey);
                            diagnostics.push({
                                from: index >= 0 ? index : 0,
                                to: index >= 0 ? index + pathKey.length : 0,
                                severity: mapSeverity(rule.severity),
                                message: `Enum values removed for request body property "${propPath}" in ${method.toUpperCase()} ${pathKey}: ${removed.join(', ')}.`,                                source: rule.id,
                            });
                        }
                    }
                }
            }

            // Compare response schema types (per status code)
            if (elements.includes("responses")) {
                for (const code in (remoteOp.responses || {})) {
                    const remoteResp = remoteOp.responses[code];
                    const currentResp = currentOp.responses?.[code];
                    const remoteSchemaRaw = remoteResp?.content?.["application/json"]?.schema;
                    const currentSchemaRaw = currentResp?.content?.["application/json"]?.schema;
                    const remoteSchema = remoteSchemaRaw?.$ref ? resolveRef(remoteSchemaRaw.$ref, remoteSpec) : remoteSchemaRaw;
                    const currentSchema = currentSchemaRaw?.$ref ? resolveRef(currentSchemaRaw.$ref, spec) : currentSchemaRaw;

                    if (remoteSchema && currentSchema) {
                        const remoteEnums = extractEnumIfExist(remoteSchema, remoteSpec);
                        const currentEnums = extractEnumIfExist(currentSchema, spec);

                        for (const [propPath, oldSet] of remoteEnums.entries()) {
                            const newSet = currentEnums.get(propPath);
                            if (!newSet) continue;
                            const removed: string[] = [];
                            for (const v of oldSet) if (!newSet.has(v)) removed.push(v);
                            if (removed.length) {
                                const index = content.indexOf(pathKey);
                                diagnostics.push({
                                    from: index >= 0 ? index : 0,
                                    to: index >= 0 ? index + pathKey.length : 0,
                                    severity: mapSeverity(rule.severity),
                                    message: `Enum values removed for response property "${propPath}" (code ${code}) in ${method.toUpperCase()} ${pathKey}: ${removed.join(', ')}.`,                                    source: rule.id,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
}

function checkDeletedRequestResponseParam(remoteSpec: any, spec: any, content: string, diagnostics: Diagnostic[], rule: any) {
    const elements: string[] = rule?.element ?? [];
    if (!elements.length) return;

    for (const pathKey in remoteSpec.paths) {
        const remotePathItem = remoteSpec.paths[pathKey];
        const currentPathItem = spec.paths[pathKey];
        if (!currentPathItem) continue;

        for (const method in remotePathItem) {
            const remoteOp = remotePathItem[method];
            const currentOp = currentPathItem[method];
            if (!currentOp) continue;

            if (elements.includes("requestBody")) {
                const remoteRef = remoteOp?.requestBody?.content?.["application/json"]?.schema?.$ref;
                const currentRef = currentOp?.requestBody?.content?.["application/json"]?.schema?.$ref;
                const remoteSchema = remoteRef && resolveRef(remoteRef, remoteSpec);
                const currentSchema = currentRef && resolveRef(currentRef, spec);
                if (remoteSchema && currentSchema) {
                    const remoteProps = extractAllProperties(remoteSchema, remoteSpec);
                    const currentProps = extractAllProperties(currentSchema, spec);
                    for (const key of remoteProps) {
                        if (!currentProps.has(key)) {
                            const index = content.indexOf(pathKey);
                            diagnostics.push({
                                from: index >= 0 ? index : 0,
                                to: index >= 0 ? index + pathKey.length : 0,
                                severity: mapSeverity(rule.severity),
                                message: `Request body property "${key}" was deleted in method ${method.toUpperCase()} at path "${pathKey}".`,
                                source: rule.id,
                            });
                        }
                    }
                }
            }
            if (elements.includes("responses")) {
                for (const code in remoteOp.responses || {}) {
                    const remoteResp = remoteOp.responses[code];
                    const currentResp = currentOp.responses?.[code];
                    const remoteSchemaRaw = remoteResp?.content?.["application/json"]?.schema;
                    const currentSchemaRaw = currentResp?.content?.["application/json"]?.schema;
                    const remoteSchema = remoteSchemaRaw?.$ref ? resolveRef(remoteSchemaRaw.$ref, remoteSpec) : remoteSchemaRaw;
                    const currentSchema = currentSchemaRaw?.$ref ? resolveRef(currentSchemaRaw.$ref, spec) : currentSchemaRaw;
                    if (remoteSchema && currentSchema) {
                        const remoteProps = extractAllProperties(remoteSchema, remoteSpec);
                        const currentProps = extractAllProperties(currentSchema, spec);
                        for (const key of remoteProps) {
                            if (!currentProps.has(key)) {
                                const index = content.indexOf(pathKey);
                                diagnostics.push({
                                    from: index >= 0 ? index : 0,
                                    to: index >= 0 ? index + pathKey.length : 0,
                                    severity: mapSeverity(rule.severity),
                                    message: `Response property "${key}" in code ${code} was deleted in method ${method.toUpperCase()} at path "${pathKey}".`,
                                    source: rule.id,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
}

function checkAddedRequestBodyParam(remoteSpec: any, spec: any, content: string, diagnostics: Diagnostic[], rule: any) {
    const elements: string[] = rule?.element ?? [];
    if (!elements.length) return;

    for (const pathKey in remoteSpec.paths) {
        const remotePathItem = remoteSpec.paths[pathKey];
        const currentPathItem = spec.paths[pathKey];
        if (!currentPathItem) continue;

        for (const method in remotePathItem) {
            const remoteOp = remotePathItem[method];
            const currentOp = currentPathItem[method];
            if (!currentOp) continue;

            if (elements.includes("requestBody")) {
                const remoteRef = remoteOp?.requestBody?.content?.["application/json"]?.schema?.$ref;
                const currentRef = currentOp?.requestBody?.content?.["application/json"]?.schema?.$ref;
                const remoteSchema = remoteRef && resolveRef(remoteRef, remoteSpec);
                const currentSchema = currentRef && resolveRef(currentRef, spec);
                if (remoteSchema && currentSchema) {
                    const remoteProps = extractAllProperties(remoteSchema, remoteSpec);
                    const currentProps = extractAllProperties(currentSchema, spec);
                    for (const key of currentProps) {
                        if (!remoteProps.has(key)) {
                            const index = content.indexOf(pathKey);
                            diagnostics.push({
                                from: index >= 0 ? index : 0,
                                to: index >= 0 ? index + pathKey.length : 0,
                                severity: mapSeverity(rule.severity),
                                message: `Request body property "${key}" was added in method ${method.toUpperCase()} at path "${pathKey}".`,
                                source: rule.id,
                            });
                        }
                    }
                }
            }
        }
    }
}

function checkDeletedRequestResponseParamTypes(remoteSpec: any, spec: any, content: string, diagnostics: Diagnostic[], rule: any) {
    const elements: string[] = rule?.element ?? [];
    if (!elements.length) return;

    for (const pathKey in remoteSpec.paths) {
        const remotePathItem = remoteSpec.paths[pathKey];
        const currentPathItem = spec.paths[pathKey];
        if (!currentPathItem) continue;

        for (const method in remotePathItem) {
            const remoteOp = remotePathItem[method];
            const currentOp = currentPathItem[method];
            if (!currentOp) continue;

            // Compare request body schema types
            if (elements.includes("requestBody")) {
                const remoteSchemaRef = remoteOp?.requestBody?.content?.["application/json"]?.schema;
                const currentSchemaRef = currentOp?.requestBody?.content?.["application/json"]?.schema;
                const remoteSchema = remoteSchemaRef?.$ref ? resolveRef(remoteSchemaRef.$ref, remoteSpec) : remoteSchemaRef;
                const currentSchema = currentSchemaRef?.$ref ? resolveRef(currentSchemaRef.$ref, spec) : currentSchemaRef;

                if (remoteSchema && currentSchema) {
                    const remoteTypes = extractPropertyTypes(remoteSchema, remoteSpec);
                    const currentTypes = extractPropertyTypes(currentSchema, spec);

                    for (const [propPath, oldType] of remoteTypes.entries()) {
                        if (!currentTypes.has(propPath)) continue; // deletion is handled by another rule
                        const newType = currentTypes.get(propPath)!;
                        if (oldType !== newType) {
                            const index = content.indexOf(pathKey);
                            diagnostics.push({
                                from: index >= 0 ? index : 0,
                                to: index >= 0 ? index + pathKey.length : 0,
                                severity: mapSeverity(rule.severity),
                                message: `Type of request body property "${propPath}" changed from "${oldType}" to "${newType}" in method ${method.toUpperCase()} at path "${pathKey}".`,
                                source: rule.id,
                            });
                        }
                    }
                }
            }

            // Compare response schema types (per status code)
            if (elements.includes("responses")) {
                for (const code in (remoteOp.responses || {})) {
                    const remoteResp = remoteOp.responses[code];
                    const currentResp = currentOp.responses?.[code];
                    const remoteSchemaRaw = remoteResp?.content?.["application/json"]?.schema;
                    const currentSchemaRaw = currentResp?.content?.["application/json"]?.schema;
                    const remoteSchema = remoteSchemaRaw?.$ref ? resolveRef(remoteSchemaRaw.$ref, remoteSpec) : remoteSchemaRaw;
                    const currentSchema = currentSchemaRaw?.$ref ? resolveRef(currentSchemaRaw.$ref, spec) : currentSchemaRaw;

                    if (remoteSchema && currentSchema) {
                        const remoteTypes = extractPropertyTypes(remoteSchema, remoteSpec);
                        const currentTypes = extractPropertyTypes(currentSchema, spec);

                        for (const [propPath, oldType] of remoteTypes.entries()) {
                            if (!currentTypes.has(propPath)) continue; // deletion handled elsewhere
                            const newType = currentTypes.get(propPath)!;
                            if (oldType !== newType) {
                                const index = content.indexOf(pathKey);
                                diagnostics.push({
                                    from: index >= 0 ? index : 0,
                                    to: index >= 0 ? index + pathKey.length : 0,
                                    severity: mapSeverity(rule.severity),
                                    message: `Type of response property "${propPath}" (code ${code}) changed from "${oldType}" to "${newType}" in method ${method.toUpperCase()} at path "${pathKey}".`,
                                    source: rule.id,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
}

export async function checkCompatibility(spec: any, content: string, rule: any): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];

    const service = await fetchRepoMap(spec);
    if (!service) return diagnostics;
    const repoName = Object.values(service)[0];

    let remoteSpec = remoteSpecCache[repoName];
    if (!remoteSpec) {
        remoteSpec = await fetchSpecFromGitea(repoName, `/openapi/${repoName}.yaml`);
        if (!remoteSpec) return diagnostics;
        remoteSpecCache[repoName] = remoteSpec;
    }

    switch (rule.id) {
        case '2.1.7.1':
            checkDeletedApi(remoteSpec, spec, content, diagnostics, rule,);
            break;
        case '2.1.7.2':
            checkDeletedRequestResponseParam(remoteSpec, spec, content, diagnostics, rule);
            break;
        case '2.1.7.3':
            checkAddedRequestBodyParam(remoteSpec, spec, content, diagnostics, rule);
            break;
        case '2.1.7.4':
            checkDeletedRequestResponseParamTypes(remoteSpec, spec, content, diagnostics, rule);
            break;
        case '2.1.7.5':
            checkEnumDecrease(remoteSpec, spec, content, diagnostics, rule);
            break;
        case '2.1.7.6':
        case '2.1.7.7':
        default:
            return diagnostics;
    }
    return diagnostics
}
