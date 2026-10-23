import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import {getSource} from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer } from "@/lib/openapi/references";

export function checkHttpsServers(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (Array.isArray(spec.servers)) {
        spec.servers.forEach((server: any, index: number) => {
            if (typeof server.url === "string" && !server.url.startsWith("https://")) {
                const { from: start, to: end } = sourceMap(content).locate(jsonPointer(["servers", index, "url"]), "value");
                diagnostics.push({
                    from: start,
                    to: end,
                    severity: mapSeverity(rule.severity),
                    message: rule.message,
                    source: getSource(rule),
                });
            }
        });
    }

    return diagnostics;
}
