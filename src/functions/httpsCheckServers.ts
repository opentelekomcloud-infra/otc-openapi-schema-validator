import { Diagnostic } from "@codemirror/lint";

export function httpsCheckServers(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const items = spec && spec[rule.given];
    if (Array.isArray(items)) {
        items.forEach((item: any) => {
            const value = item[rule.element];
            if (typeof value === "string" && !value.startsWith("https://")) {
                // Locate the value in the content to highlight it
                const index = content.indexOf(value);
                const start = index >= 0 ? index : 0;
                const end = index >= 0 ? start + value.length : content.length;
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: rule.severity,
                    message: rule.message,
                });
            }
        });
    }

    return diagnostics;
}
