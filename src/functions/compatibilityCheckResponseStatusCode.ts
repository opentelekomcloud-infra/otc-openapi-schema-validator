import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
// import yaml from "js-yaml";



export async function compatibilityCheckResponseStatusCode(spec: any, content: string, rule: any): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const service = await fetchRepoMap(spec);
    // @ts-expect-error overload error
    const repoName = Object.values(service)[0];

    if (!service) return diagnostics;
    const remoteYaml = await fetchSpecFromGitea(repoName, `/openapi/${repoName}.yaml`);
    if (!remoteYaml) return diagnostics;

    // Do something

    diagnostics.push({
        from: 0,
        to: 0,
        severity: mapSeverity(rule.severity),
        message: rule.message,
        source: rule.id,
    });

    return diagnostics;
}
