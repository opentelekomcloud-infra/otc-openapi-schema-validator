import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";

export function checkURIResourceFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const params = rule?.call?.functionParams ?? rule?.functionParams ?? {};

    // Common non-crud action/verb segments that may appear at the end of a URI
    const verbLikeTailArr: string[] = Array.isArray(params?.verbLikeTail) ? params.verbLikeTail : [];
    const verbLikeTail = new Set<string>(verbLikeTailArr.map((s) => String(s).toLowerCase()));

    // Words that end with 's' but are commonly singular in APIs
    const endsWithSButSingularArr: string[] = Array.isArray(params?.endsWithSButSingular) ? params.endsWithSButSingular : [];
    const endsWithSButSingular = new Set<string>(endsWithSButSingularArr.map((s) => String(s).toLowerCase()));

    const exceptionNote: string = params?.exception ?? "";

    const versionRegex = /^v[0-9]+(\.[0-9]+)?$/;
    const pathParamRegex = /^\{[a-z0-9_]+\}$/;

    function isPluralResource(seg: string): boolean {
        const s = seg.toLowerCase();
        if (endsWithSButSingular.has(s)) return false;
        return s.endsWith("s");
    }

    function isVerbTail(seg: string, method: string): boolean {
        const s = seg.toLowerCase();
        if (verbLikeTail.has(s)) return true;
        return ["post", "put", "patch"].includes(method.toLowerCase()) && !isPluralResource(s);
    }

    function findLeafResourceSegment(pathKey: string, method: string): { segment: string | null; reason: string } {
        const segments = pathKey.split("/").filter(Boolean);
        const filtered: string[] = [];

        // Remove version segment and keep others in order
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (i === 0 && versionRegex.test(seg)) continue;
            filtered.push(seg);
        }

        if (filtered.length === 0) return { segment: null, reason: "empty" };

        // If the last segment is a param, leaf resource is the previous non-param segment
        let idx = filtered.length - 1;
        if (pathParamRegex.test(filtered[idx])) {
            idx -= 1;
        }

        if (idx < 0) return { segment: null, reason: "no-resource" };

        // If tail is verb-like, step back one more (but still skip params)
        if (!pathParamRegex.test(filtered[idx]) && isVerbTail(filtered[idx], method)) {
            idx -= 1;
            while (idx >= 0 && pathParamRegex.test(filtered[idx])) idx -= 1;
        }

        if (idx < 0) return { segment: null, reason: "no-resource" };

        // If still pointing at a param (edge-case), step back
        while (idx >= 0 && pathParamRegex.test(filtered[idx])) idx -= 1;
        if (idx < 0) return { segment: null, reason: "no-resource" };

        return { segment: filtered[idx], reason: "ok" };
    }

    for (const pathKey of Object.keys(spec.paths)) {
        const pathItem = spec.paths[pathKey];
        if (!pathItem || typeof pathItem !== "object") continue;

        for (const method of Object.keys(pathItem)) {
            const m = method.toLowerCase();
            if (!(["get", "post", "put", "patch", "delete"].includes(m))) continue;

            const leaf = findLeafResourceSegment(pathKey, m);
            if (!leaf.segment) continue;

            // Skip if leaf segment is a param (should not happen but safe)
            if (pathParamRegex.test(leaf.segment)) continue;

            if (!isPluralResource(leaf.segment)) {
                const index = content.indexOf(pathKey);
                const extra = exceptionNote ? ` Exception: ${exceptionNote}` : "";
                diagnostics.push({
                    from: index >= 0 ? index : 0,
                    to: index >= 0 ? index + pathKey.length : 0,
                    severity: mapSeverity(rule.severity),
                    message: `Resource segment "${leaf.segment}" in path "${pathKey}" should be plural for CRUD operations.${extra}`,
                    source: rule.id,
                });
            }
        }
    }

    return diagnostics;
}
