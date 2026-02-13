import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

export function checkURIFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    // Read allowed formats from rule params (if provided) so the rule is configurable
    const scopeFormats = (rule?.call.functionParams?.allowedFormats?.scope ?? []) as Array<Record<string, string>>;

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
    const projectOrTenantRegex = /^\{(project_id|tenant_id)\}$/;

    for (const pathKey of Object.keys(spec.paths)) {
        if (!pathKey.startsWith("/")) continue;

        const segments = pathKey.split("/").filter(Boolean); // remove empty segments from leading/trailing slashes
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
                source: getSource(rule),
            });
            continue;
        }

        // No additional version-like segments are allowed after the first
        let hasExtraVersion = false;
        for (let i = 1; i < segments.length; i++) {
            if (versionRegex.test(segments[i])) {
                hasExtraVersion = true;
                break;
            }
        }

        if (hasExtraVersion) {
            const index = content.indexOf(pathKey);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" must not contain additional version segments after the leading /{version}.`,
                source: getSource(rule),
            });
            continue;
        }

        // Detect if this looks like a "domain"-scope URI:
        //   /{version}/{project_id}/{resources}
        //   /{version}/{tenant_id}/{resources}
        let isDomainScope = false;
        if (segments.length >= 2) {
            const second = segments[1];
            if (projectOrTenantRegex.test(second)) {
                isDomainScope = true;
            }
        }

        // project_id/tenant_id may appear only as the second segment (domain scope); any further occurrence is invalid
        let hasMisplacedProjectOrTenant = false;
        for (let i = 2; i < segments.length; i++) {
            if (projectOrTenantRegex.test(segments[i])) {
                hasMisplacedProjectOrTenant = true;
                break;
            }
        }

        if (hasMisplacedProjectOrTenant) {
            const index = content.indexOf(pathKey);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" must use project_id/tenant_id only immediately after the version segment ("/${versionSegment}/{project_id|tenant_id}/...").`,
                source: getSource(rule),
            });
            continue;
        }

        // Domain-scope URIs must have at least one resource segment after {project_id}/{tenant_id}
        if (isDomainScope && segments.length < 3) {
            const index = content.indexOf(pathKey);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" must contain at least one resource segment after {project_id|tenant_id} according to URI format ${domainPattern}.`,
                source: getSource(rule),
            });
            continue;
        }

        // Validate according to scope rules:
        // - project scope: /{version}/{resources}  -> at least two segments (version + resource)
        // - domain scope:  /{version}/[project_id/tenant_id]/{resources} -> at least three segments
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
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
