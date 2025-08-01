import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";

const remoteSpecCache: Record<string, any> = {};

const resolveRef = (ref: string, spec: any): any => {
    if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    const refPath = ref.slice(2).split('/');
    let resolved = spec;
    for (const part of refPath) {
        if (resolved instanceof Map) {
            resolved = resolved.get(part);
        } else if (typeof resolved === 'object') {
            resolved = resolved[part];
        } else {
            return undefined;
        }
    }
    return resolved;
};

function extractAllProperties(schema: any, spec: any): Set<string> {
    const props = new Set<string>();

    function walk(node: any) {
        if (!node) return;

        if (node.$ref) {
            const resolved = resolveRef(node.$ref, spec);
            walk(resolved);
            return;
        }

        if (node.type === 'object' && node.properties) {
            for (const key in node.properties) {
                props.add(key);
                walk(node.properties[key]);
            }
        } else if (node.type === 'array' && node.items) {
            walk(node.items);
        }
    }

    walk(schema);
    return props;
}

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
        case '2.1.7.1': {
            checkDeletedApi(remoteSpec, spec, content, diagnostics, rule,);
            break;
        }
        case '2.1.7.2':
            checkDeletedRequestResponseParam(remoteSpec, spec, content, diagnostics, rule);
            break;
        case '2.1.7.3':
        case '2.1.7.4':
        case '2.1.7.5':
        case '2.1.7.6':
        case '2.1.7.7':
        case '2.1.7.8':
        default:
            return diagnostics;
    }
    return diagnostics
}
