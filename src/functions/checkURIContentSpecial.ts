import {Diagnostic} from "@codemirror/lint";
import {mapSeverity} from "@/utils/mapSeverity";
import {findInvalidPercentEscape} from "@/utils/strings";
import { pathRange } from "@/lib/openapi/sourceMap";
import { rulePathKeys } from "@/utils/nativeRule";

export function checkURIContentSpecial(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const rawForbidden = rule?.call?.functionParams?.forbiddenChars;
    const forbiddenList: string[] = Array.isArray(rawForbidden)
        ? rawForbidden.flatMap((v: any) => (typeof v === 'string' ? v.split('') : []))
        : typeof rawForbidden === 'string'
            ? rawForbidden.split('')
            : [];

    const forbiddenSet = new Set(forbiddenList.filter(Boolean));
    if (forbiddenSet.size === 0 && !rule?.call?.functionParams?.checkInvalidPercentEscape) {
        return diagnostics;
    }

    const paths = rulePathKeys(spec);

    const mkMessage = (path: string, detail?: string) => {
        const base = rule?.message || rule?.title || 'URI contains forbidden special characters.';
        const idPrefix = rule?.id ? `${rule.id}: ` : '';
        return detail
            ? `${idPrefix}${base}\n${detail}\nPath: ${path}`
            : `${idPrefix}${base}\nPath: ${path}`;
    };

    for (const path of paths) {
        if (rule?.call?.functionParams?.checkInvalidPercentEscape) {
            const invalid = findInvalidPercentEscape(String(path));
            if (invalid) {
                const { from, to } = pathRange(content, path);
                diagnostics.push({
                    from,
                    to,
                    severity: mapSeverity(rule?.severity),
                    message: mkMessage(path, 'Invalid percent-escape token. Use % followed by two hex digits.'),
                });
            }
        }

        // Special handling for "." and ".." as reserved path segments.
        // If a segment is exactly '.' or '..', it should be percent-encoded.
        const segments = String(path).split('/').filter(Boolean);
        for (const seg of segments) {
            if (seg === '.' || seg === '..') {
                const range = pathRange(content, path);
                diagnostics.push({
                    from: range.from,
                    to: range.to,
                    severity: mapSeverity(rule?.severity),
                    message: mkMessage(path, `Found forbidden segment "${seg}".`),
                });
            }
        }

        // Character-by-character scan for forbidden special chars in the path string.
        for (let i = 0; i < String(path).length; i++) {
            const ch = path[i];

            // Skip percent-encoded sequences like %2E
            if (ch === '%' && i + 2 < path.length) {
                i += 2;
                continue;
            }

            if (!forbiddenSet.has(ch)) continue;
            const { from, to } = pathRange(content, path);

            diagnostics.push({
                from,
                to,
                severity: mapSeverity(rule?.severity),
                message: mkMessage(path, `Found forbidden character "${ch}".`),
            });
        }
    }

    return diagnostics;
}
