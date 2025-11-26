import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";

export function checkURIFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    // Read allowed formats from rule params (if provided) so the rule is configurable
    const scopeFormats = (rule?.functionParams?.allowedFormats?.scope ?? []) as Array<Record<string, string>>;

    let projectPattern = "";
    let domainPattern = "";

    for (const entry of scopeFormats) {
        const [[name, value]] = Object.entries(entry) as [string, string][];
        if (name === "project") projectPattern = value;
        if (name === "domain") domainPattern = value;
    }

    // defaults
    if (!projectPattern) projectPattern = "/{version}/{resources}";
    if (!domainPattern) domainPattern = "/{version}/[project_id/tenant_id]/{resources}";

    const versionRegex = /^v[0-9]+(\.[0-9]+)?$/;

    for (const pathKey of Object.keys(spec.paths)) {
        if (typeof pathKey !== "string" || !pathKey.startsWith("/")) continue;

        const segments = pathKey.split("/").filter(Boolean);
        if (segments.length === 0) continue; // skip root

        const versionSegment = segments[0];

        // First segment must be a version like v1, v2, v1.1, etc.
        if (!versionRegex.test(versionSegment)) {
            const index = content.indexOf(pathKey);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" must start with a version segment like /v1 according to URI format ${projectPattern}.`,
                source: rule.id,
            });
            continue;
        }

        // Detect if this looks like a "domain"-scope URI:
        //   /{version}/{project_id}/{resources}
        //   /{version}/{tenant_id}/{resources}
        let isDomainScope = false;
        if (segments.length >= 3) {
            const second = segments[1];
            if (/^\{(project_id|tenant_id)\}$/.test(second)) {
                isDomainScope = true;
            }
        }


        let isValid = false;
        if (isDomainScope) {
            // /v1/{project_id}/resources
            if (segments.length >= 3) {
                isValid = true;
            }
        } else {
            // project scope: /v1/resources
            if (segments.length >= 2) {
                isValid = true;
            }
        }

        if (!isValid) {
            const index = content.indexOf(pathKey);
            const allowedDesc = [projectPattern, domainPattern].filter(Boolean).join(" or ");
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" does not follow allowed URI formats: ${allowedDesc}.`,
                source: rule.id,
            });
        }
    }

    return diagnostics;
}
