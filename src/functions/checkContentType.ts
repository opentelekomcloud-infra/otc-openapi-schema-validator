import type { Diagnostic } from "@codemirror/lint";
import type { NativeRequestPayload, NativeResponsePayload } from "@/types/openapi";
import { getResponsePayload } from "@/lib/openapi/payloads";
import { parseDeclaredMediaType } from "@/utils/mediaType";
import { ruleDiagnostic, ruleOperations, ruleRequest, ruleStrings, type NativeRule } from "@/utils/nativeRule";
import { isRecord } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";

export function checkContentType(spec: unknown, content: string, rule: NativeRule): Diagnostic[] {
    const params = rule.call.functionParams ?? {};
    const direction = params.direction;
    if (direction !== "request" && direction !== "response" && direction !== "both") {
        throw new Error("functionParams.direction must be request, response or both.");
    }
    if (params.requireUtf8Json !== undefined && typeof params.requireUtf8Json !== "boolean") {
        throw new Error("functionParams.requireUtf8Json must be a boolean.");
    }
    const allowed = ruleStrings(params.allowedMediaTypes, "allowedMediaTypes").map((value) => {
        const parsed = parseDeclaredMediaType(value, "#");
        if (parsed.parameters.size) throw new Error("allowedMediaTypes must contain base media types without parameters.");
        return parsed.base;
    });
    if (params.allowedMediaTypes !== undefined && !allowed.length) {
        throw new Error("functionParams.allowedMediaTypes must not be empty.");
    }
    const diagnostics: Diagnostic[] = [];
    const cache = new Map<string, unknown>();
    const check = (payload: NativeRequestPayload | NativeResponsePayload, pointer: string, label: string) => {
        if (!payload.hasBody) return;
        const media = payload.media.map((entry) => ({
            ...parseDeclaredMediaType(entry.mediaType, entry.pointer), pointer: entry.pointer,
        }));
        if (!media.length) {
            diagnostics.push(ruleDiagnostic(content, rule, pointer, `${label}: a body media type must be declared.`));
            return;
        }
        const invalidCharset = params.requireUtf8Json === true && media.find((entry) =>
            entry.base === "application/json" && entry.parameters.has("charset") &&
            entry.parameters.get("charset")?.toLowerCase() !== "utf-8");
        if (invalidCharset) {
            diagnostics.push(ruleDiagnostic(content, rule, invalidCharset.pointer, `${label}: JSON charset must be UTF-8.`,
                payload.dialect === "swagger2" ? "value" : "key"));
        } else if (allowed.length && !media.some((entry) => allowed.includes(entry.base))) {
            diagnostics.push(ruleDiagnostic(content, rule,
                payload.mediaTypes.state === "declared" ? payload.mediaTypes.pointer : pointer,
                `${label}: expected at least one of [${allowed.join(", ")}].`));
        }
    };
    for (const op of ruleOperations(spec, params)) {
        if (direction !== "response") {
            const request = ruleRequest(op, spec, cache);
            const pointer = request.kind === "body" ? request.body.resolvedPointer : op.pointer;
            check(request, pointer, "Request");
        }
        if (direction === "request" || op.operation.responses === undefined) continue;
        if (!isRecord(op.operation.responses)) {
            throw new NativeAccessorError("INVALID_DECLARATION", op.pointer, "Expected a responses object");
        }
        for (const status of Object.keys(op.operation.responses)) {
            if (status.startsWith("x-")) continue;
            const response = getResponsePayload(op.operation, status, spec, cache, op.pointer);
            if (response) check(response, response.response.resolvedPointer, `Response ${status}`);
        }
    }
    return diagnostics;
}
