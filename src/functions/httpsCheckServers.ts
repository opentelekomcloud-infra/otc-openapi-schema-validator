import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";

export function httpsCheckServers(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec || typeof spec.get !== "function") {
        console.warn("Invalid spec format in httpsCheckServers");
        return diagnostics;
    }

    const servers = spec.get("servers");
    if (Array.isArray(servers)) {
        servers.forEach((server: any) => {
            const url = server.get("url");
            if (typeof url === "string" && !url.startsWith("https://")) {
                const index = content.indexOf(url);
                const start = index >= 0 ? index : 0;
                const end = index >= 0 ? start + url.length : content.length;
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
