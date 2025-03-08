// /functions/mediaTypeCheck.ts
import { Diagnostic } from "@codemirror/lint";

function getLineBoundaries(content: string, index: number): { from: number; to: number } {
    const from = content.lastIndexOf("\n", index) + 1;
    let to = content.indexOf("\n", index);
    if (to === -1) to = content.length;
    return { from, to };
}

export function mediaTypeCheck(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const allowedMediaTypes = ["application/json", "application/octet-stream", "multipart/form-data"];
    const methodsToCheck = rule.then.functionParams;

    if (!spec || !spec.paths) {
        return diagnostics;
    }
    for (const pathKey in spec.paths) {
        const pathItem = spec.paths[pathKey];

        methodsToCheck.forEach((method: string) => {
            const operation = pathItem[method];
            if (operation) {
                // Check if the operation defines a requestBody.
                if ("requestBody" in operation) {
                    const reqContent = operation.requestBody?.content;
                    let index = content.indexOf(pathKey);
                    const rbIndex = content.indexOf("requestBody:", index);
                    if (rbIndex >= 0) {
                        index = rbIndex;
                    }
                    if (!reqContent || Object.keys(reqContent).length === 0) {
                        const { from, to } = getLineBoundaries(content, index >= 0 ? index : 0);
                        diagnostics.push({
                            from,
                            to,
                            severity: rule.severity,
                            message: `Operation ${method.toUpperCase()} at path ${pathKey}: requestBody is present but is empty or missing a 'content' element.`,
                        });
                    } else {
                        const mediaKeys = Object.keys(reqContent);
                        const valid = mediaKeys.some(key => allowedMediaTypes.includes(key));
                        if (!valid) {
                            const { from, to } = getLineBoundaries(content, index >= 0 ? index : 0);
                            diagnostics.push({
                                from,
                                to,
                                severity: rule.severity,
                                message: `Operation ${method.toUpperCase()} at path ${pathKey}: requestBody 'content' does not include an allowed media type. Allowed types: ${allowedMediaTypes.join(", ")}.`,
                            });
                        }
                    }
                    // Check responses for each operation.
                    if (operation.responses) {
                        for (const responseKey in operation.responses) {
                            const response = operation.responses[responseKey];
                            const respIndex = content.indexOf("responses:", index);
                            if (respIndex >= 0) {
                                index = respIndex;
                            }
                            if (!response.content || Object.keys(response.content).length === 0) {
                                const { from, to } = getLineBoundaries(content, index >= 0 ? index : 0);
                                diagnostics.push({
                                    from,
                                    to,
                                    severity: rule.severity,
                                    message: `Operation ${method.toUpperCase()} at path ${pathKey}: response ${responseKey} is missing 'content' or it is empty.`,
                                });
                            } else {
                                const mediaKeys = Object.keys(response.content);
                                const valid = mediaKeys.some(key => allowedMediaTypes.includes(key));
                                if (!valid) {
                                    const { from, to } = getLineBoundaries(content, index >= 0 ? index : 0);
                                    diagnostics.push({
                                        from,
                                        to,
                                        severity: rule.severity,
                                        message: `Operation ${method.toUpperCase()} at path ${pathKey}: response ${responseKey} 'content' does not include an allowed media type. Allowed types: ${allowedMediaTypes.join(", ")}.`,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        });
    }
    return diagnostics;
}
