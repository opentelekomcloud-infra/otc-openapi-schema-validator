import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

export function checkURIContentComplexity(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const severityThresholdsRaw: Array<Record<string, number>> = rule?.call?.functionParams?.severity ?? [];

    // Build a threshold map like: { medium: 4, high: 5, critical: 6 }
    const thresholdMap: Record<string, number> = {};
    for (const entry of severityThresholdsRaw) {
        const [k, v] = Object.entries(entry || {})[0] ?? [];
        thresholdMap[k] = v;
    }

    const mediumThreshold = thresholdMap.medium ?? 0;
    const highThreshold = thresholdMap.high ?? 0;
    const criticalThreshold = thresholdMap.critical ?? 0;

    const versionRegex = /^v[0-9]+(\.[0-9]+)?$/;
    const pathParamRegex = /^\{[a-z0-9_]+\}$/;

    function computeDepth(pathKey: string): number {
        const segments = pathKey.split("/").filter(Boolean);
        const startIdx = segments.length > 0 && versionRegex.test(segments[0]) ? 1 : 0;
        let depth = 0;
        for (let i = startIdx; i < segments.length; i++) {
            const seg = segments[i];
            // Count only real resource segments; ignore path params
            if (pathParamRegex.test(seg)) continue;
            depth += 1;
        }
        return depth;
    }

    function severityForDepth(depth: number): string | null {
        if (criticalThreshold > 0 && depth >= criticalThreshold) return "critical";
        if (highThreshold > 0 && depth >= highThreshold) return "high";
        if (mediumThreshold > 0 && depth >= mediumThreshold) return "medium";
        return null;
    }

    for (const pathKey of Object.keys(spec.paths)) {
        const depth = computeDepth(pathKey);
        const dynamicSeverity = severityForDepth(depth);
        if (!dynamicSeverity) continue;

        const index = content.indexOf(pathKey);
        diagnostics.push({
            from: index >= 0 ? index : 0,
            to: index >= 0 ? index + pathKey.length : 0,
            severity: mapSeverity(dynamicSeverity),
            message: `Path "${pathKey}" is overly complex (resource depth: ${depth}). Consider simplifying the URI by removing redundant nested segments.`,
            source: getSource(rule),
        });
    }

    return diagnostics;
}
