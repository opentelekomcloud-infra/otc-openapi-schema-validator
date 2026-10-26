import type { Diagnostic } from "@codemirror/lint";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import { appendPointer } from "@/lib/openapi/references";
import { getNativeTransport } from "@/lib/openapi/transport";
import { ruleDiagnostic, ruleOperations, type NativeRule } from "@/utils/nativeRule";

export function checkHttpsServers(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const native = classifyNativeOpenApiDocument(spec);
    const operations = ruleOperations(spec, rule.call.functionParams ?? {});
    const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();
    const report = (pointer: string, details = "", kind: "key" | "value" = "key") => {
        if (seen.has(pointer)) return;
        seen.add(pointer);
        diagnostics.push(ruleDiagnostic(content, rule, pointer, details, kind));
    };
    for (const operation of operations.length ? operations : [undefined]) {
        const transport = getNativeTransport(native, operation);
        if (transport.kind === "unspecified") {
            report("#", "HTTPS cannot be verified: no transport is declared.");
        } else if (transport.kind === "schemes") {
            if (!transport.declaration.values.length) {
                report(transport.declaration.pointer, "HTTPS cannot be verified: schemes is empty.");
            }
            transport.declaration.values.forEach((scheme, index) => {
                if (scheme.toLowerCase() !== "https") report(appendPointer(transport.declaration.pointer, index), "", "value");
            });
        } else {
            if (!transport.servers.length) report(transport.pointer, "HTTPS cannot be verified: servers is empty.");
            for (const server of transport.servers) {
                if (server.scheme !== "https") {
                    report(appendPointer(server.pointer, "url"),
                        server.scheme === undefined ? "HTTPS cannot be verified: the server protocol is undetermined." : "", "value");
                }
            }
        }
    }
    return diagnostics;
}
