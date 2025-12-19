import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";

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
    if (forbiddenSet.size === 0) return diagnostics;

    const paths: string[] = Object.keys(spec.paths || {});

    const mkMessage = (path: string, ch: string) => {
        const base = rule?.message || rule?.title || 'URI contains forbidden special characters.';
        const idPrefix = rule?.id ? `${rule.id}: ` : '';
        return `${idPrefix}${base}\nFound forbidden character "${ch}" in path: ${path}`;
    };

    const findPosition = (needle: string, offset = 0) => {
        try {
            const idx = content.indexOf(needle, offset);
            return idx;
        } catch {
            return -1;
        }
    };

    for (const path of paths) {
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
                    message: mkMessage(path, seg),
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
                message: mkMessage(path, ch),
            });
        }
    }

    return diagnostics;
}
