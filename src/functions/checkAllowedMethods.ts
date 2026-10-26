import type { Diagnostic } from "@codemirror/lint";
import { appendPointer, isRecord, jsonPointer, resolveObjectReference } from "@/lib/openapi/references";
import { ruleDiagnostic, ruleDocument, ruleStrings, type NativeRule } from "@/utils/nativeRule";
import { NativeAccessorError } from "@/lib/openapi/accessorError";

const metadata = new Set(["parameters", "servers", "summary", "description", "$ref"]);

export function checkAllowedMethods(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const methods = ruleStrings(rule.call.functionParams?.methods, "methods");
    if (!methods.length) throw new Error("functionParams.methods must not be empty.");
    const allowed = new Set(methods.map((method) => method.toLowerCase()));
    const document = ruleDocument(spec);
    if (!isRecord(document.paths)) return [];
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    for (const [path, raw] of Object.entries(document.paths)) {
        if (!path.startsWith("/")) continue;
        const resolved = resolveObjectReference(raw, spec, cache, jsonPointer(["paths", path]), "reject");
        if (!resolved) throw new NativeAccessorError("INVALID_DECLARATION", jsonPointer(["paths", path]), "Expected a Path Item object");
        // Invalid/unsupported operation keys, including Swagger TRACE, must not disappear in the valid-method iterator.
        for (const key of Object.keys(resolved.value)) {
            if (metadata.has(key) || key.startsWith("x-") || allowed.has(key.toLowerCase())) continue;
            diagnostics.push(ruleDiagnostic(content, rule, appendPointer(resolved.pointer, key)));
        }
    }
    return diagnostics;
}
