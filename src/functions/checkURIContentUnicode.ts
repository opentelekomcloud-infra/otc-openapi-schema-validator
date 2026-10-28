import {Diagnostic} from "@codemirror/lint";
import {mapSeverity} from "@/utils/mapSeverity";
import {findInvalidPercentEscape} from "@/utils/strings";
import {getSource} from "@/functions/common";
import { pathRange } from "@/lib/openapi/sourceMap";
import { rulePathKeys } from "@/utils/nativeRule";

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

    for (const pathKey of rulePathKeys(spec)) {
        if (checkInvalidPercentEscape) {
            const invalid = findInvalidPercentEscape(pathKey);
            if (invalid) {
                const { from, to } = pathRange(content, pathKey);
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

            const { from, to } = pathRange(content, pathKey);

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
