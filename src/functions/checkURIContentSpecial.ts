import {Diagnostic} from "@codemirror/lint";
import {mapSeverity} from "@/utils/mapSeverity";
import {findInvalidPercentEscape} from "@/utils/strings";

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

    const paths: string[] = Object.keys(spec.paths || {});

    const mkMessage = (path: string, detail?: string) => {
        const base = rule?.message || rule?.title || 'URI contains forbidden special characters.';
        const idPrefix = rule?.id ? `${rule.id}: ` : '';
        return detail
            ? `${idPrefix}${base}\n${detail}\nPath: ${path}`
            : `${idPrefix}${base}\nPath: ${path}`;
    };

    const findPosition = (needle: string, offset = 0) => {
        try {
            return content.indexOf(needle, offset);
        } catch {
            return -1;
        }
    };

    for (const path of paths) {
        if (rule?.call?.functionParams?.checkInvalidPercentEscape) {
            const invalid = findInvalidPercentEscape(String(path));
            if (invalid) {
                const pathIdx = findPosition(path);
                const from = pathIdx >= 0 ? pathIdx + invalid.index : 0;
                const to = pathIdx >= 0 ? pathIdx + invalid.index + invalid.length : Math.min(1, content.length);
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
                const idx = findPosition(path);
                diagnostics.push({
                    from: idx >= 0 ? idx : 0,
                    to: idx >= 0 ? idx + path.length : Math.min(1, content.length),
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
            const pathIdx = findPosition(path);
            const from = pathIdx >= 0 ? pathIdx + i : 0;
            const to = pathIdx >= 0 ? pathIdx + i + 1 : Math.min(1, content.length);

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
