import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";

function getByteLength(str: string): number {
    if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(str).length;
    }
    // Fallback: approximate by treating non-ASCII as 2 bytes (conservative)
    let len = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code <= 0x7f) len += 1;
        else if (code <= 0x7ff) len += 2;
        else if (code <= 0xffff) len += 3;
        else len += 4;
    }
    return len;
}

export function checkURILength(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const maxLength: number = rule?.call.functionParams?.maxLength ?? 2048;

    for (const pathKey of Object.keys(spec.paths)) {
        // Encode the path as a URI and measure its byte length (UTF-8)
        const encoded = encodeURI(pathKey);
        const lengthBytes = getByteLength(encoded);

        if (lengthBytes > maxLength) {
            const index = content.indexOf(pathKey);
            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" exceeds the maximum allowed URI length of ${maxLength} bytes after encoding (actual: ${lengthBytes}).`,
                source: getSource(rule),
            });
        }
    }

    return diagnostics;
}
