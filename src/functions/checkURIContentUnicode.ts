import {Diagnostic} from "@codemirror/lint";
import {mapSeverity} from "@/utils/mapSeverity";
import {findInvalidPercentEscape} from "@/utils/strings";
import {getSource} from "@/functions/common";

export function checkURIContentUnicode(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const checkInvalidPercentEscape = Boolean(rule?.call?.functionParams?.checkInvalidPercentEscape);

    const mkMessage = (path: string, detail?: string) => {
        const base = rule?.message || rule?.title || 'URI contains invalid characters.';
        const idPrefix = rule?.id ? `${rule.id}: ` : '';
        return detail
            ? `${idPrefix}${base}\n${detail}\nPath: ${path}`
            : `${idPrefix}${base}\nPath: ${path}`;
    };

    const findPathPosition = (pathKey: string) => {
        return content.indexOf(pathKey);
    };

    for (const pathKey of Object.keys(spec.paths || {})) {
        if (checkInvalidPercentEscape) {
            const invalid = findInvalidPercentEscape(pathKey);
            if (invalid) {
                const baseIdx = findPathPosition(pathKey);
                const from = baseIdx >= 0 ? baseIdx + invalid.index : 0;
                const to = baseIdx >= 0 ? baseIdx + invalid.index + invalid.length : Math.min(1, content.length);
                diagnostics.push({
                    from,
                    to,
                    severity: mapSeverity(rule?.severity),
                    message: mkMessage(pathKey, 'Invalid percent-escape token. Use % followed by two hex digits.'),
                    source: getSource(rule),
                });
            }
        }

        // Detect any non-ASCII characters directly present in the path
        const s = String(pathKey);
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch.charCodeAt(0) <= 0x7f) continue;

            const baseIdx = findPathPosition(pathKey);
            const from = baseIdx >= 0 ? baseIdx + i : 0;
            const to = baseIdx >= 0 ? baseIdx + i + 1 : Math.min(1, content.length);

            diagnostics.push({
                from,
                to,
                severity: mapSeverity(rule?.severity),
                message: mkMessage(pathKey, `Unicode character detected: "${ch}". Use percent-encoding instead.`),
                source: getSource(rule),
            });
            break;
        }
    }

    return diagnostics;
}
