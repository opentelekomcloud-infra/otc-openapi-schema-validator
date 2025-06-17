import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";

export function checkHttpsServers(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (Array.isArray(spec.servers)) {
        spec.servers.forEach((server: any) => {
            if (typeof server.url === "string" && !server.url.startsWith("https://")) {
                const index = content.indexOf(server.url);
                const start = index >= 0 ? index : 0;
                const end = index >= 0 ? start + server.url.length : content.length;
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: rule.message,
                    source: rule.id,
                });
            }
        });
    }

    return diagnostics;
}
