import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

/**
 * QUE-050-01-2507-2507-M
 * Cloud services must provide APIs for querying their own service quotas.
 *
 * This rule checks that the OpenAPI specification exposes a quota query endpoint,
 * such as GET /v1/quotas.
 *
 * Behavior is controlled via rule.call.functionParams:
 * - pathPattern: string
 *   Path suffix or pattern to match quota endpoints (e.g. "/quotas").
 * - method: string
 *   HTTP method required on the quota endpoint (default: "get").
 *
 * The rule scans all paths and succeeds if at least one matching path
 * defines the required HTTP method.
 */
export function checkQuotaApiPresence(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const params = rule?.call?.functionParams ?? {};
    const pathPatternRaw = typeof params.pathPattern === "string" ? params.pathPattern : "/quotas";
    const method = String(params.method ?? "get").toLowerCase();

    const pattern = pathPatternRaw.trim();
    const normalizedPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;

    function matchesQuotaPath(pathKey: string): boolean {
        const p = String(pathKey);
        const pNoSlash = p.endsWith("/") ? p.slice(0, -1) : p;

        if (normalizedPattern.startsWith("/") && normalizedPattern.endsWith("/") && normalizedPattern.length > 1) {
            try {
                const reBody = normalizedPattern.slice(1, -1);
                const re = new RegExp(reBody);
                return re.test(p);
            } catch {}
        }

        // Suffix match (covers /v1/quotas, /v1/{project_id}/quotas, etc.)
        return pNoSlash === normalizedPattern || pNoSlash.endsWith(normalizedPattern);
    }

    let found = false;
    for (const pathKey of Object.keys(spec.paths)) {
        if (!matchesQuotaPath(pathKey)) continue;

        const pathItem = spec.paths[pathKey];
        if (!pathItem || typeof pathItem !== "object") continue;

        if (pathItem[method]) {
            found = true;
            break;
        }
    }

    if (!found) {
        // Best-effort highlight: point to `paths` key.
        const idx = content.indexOf("\npaths:");
        const from = idx >= 0 ? idx + 1 : 0;
        const to = idx >= 0 ? from + "paths".length : 0;

        diagnostics.push({
            from,
            to,
            severity: mapSeverity(rule.severity),
            message: rule.message,
            source: getSource(rule),
        });
    }

    return diagnostics;
}
