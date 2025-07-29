import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";

export async function checkCompatibility(spec: any, content: string, rule: any): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const allowedMethods = rule.call.functionParams.methods.map((m: string) => m.toLowerCase());

    const service = await fetchRepoMap(spec);
    // @ts-expect-error overload error
    const repoName = Object.values(service)[0];

    if (!service) return diagnostics;
    const remoteSpec = await fetchSpecFromGitea(repoName, `/openapi/${repoName}.yaml`);
    if (!remoteSpec) return diagnostics;

    switch (rule.id) {
        case '2.1.7.1': {
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
            break;
        }
        case '2.1.7.2':
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
