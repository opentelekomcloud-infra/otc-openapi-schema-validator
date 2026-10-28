import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { violatingIndexRange } from "@/utils/pos";
import {getSource} from "@/functions/common";
import { appendPointer } from "@/lib/openapi/references";
import { isSwagger2Root } from "@/lib/openapi/media";
import { NativeAccessorError } from "@/lib/openapi/accessorError";

const DEFAULT_CHINESE_UNICODE_RANGE = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";

function containsForbiddenChars(text: string, forbiddenRe: RegExp): boolean {
    return forbiddenRe.test(text);
}

type WalkCtx = {
    diagnostics: Diagnostic[];
    content: string;
    rule: any;
    elementKeys: Set<string>;
    forbiddenLanguages: string[];
};

function pushIfViolation(value: unknown, pointer: string, sourcePointer: string, ctx: WalkCtx) {
    if (typeof value !== "string" || !value.trim()) return;

    // Currently we only implement forbiddenLanguages: ['zh'] by detecting Chinese characters.
    // If 'zh' is not in forbiddenLanguages, we do nothing.
    if (!ctx.forbiddenLanguages.map((x) => String(x).toLowerCase()).includes("zh")) return;

    const range = typeof ctx.rule?.call?.functionParams?.forbiddenUnicodeRange === "string"
        ? ctx.rule.call.functionParams.forbiddenUnicodeRange
        : DEFAULT_CHINESE_UNICODE_RANGE;

    const forbiddenRe = new RegExp(`[${range}]`);

    if (!containsForbiddenChars(value, forbiddenRe)) return;

    const { from, to } = violatingIndexRange(ctx.content, sourcePointer);
    ctx.diagnostics.push({
        from,
        to,
        severity: mapSeverity(ctx.rule.severity),
        message: `Non-English (Chinese) text detected at ${pointer}. Only English is allowed for this field.`,
        source: getSource(ctx.rule),
    });
}

function walkObject(node: unknown, pointer: string, ctx: WalkCtx, sourcePointer = `#${pointer}`) {
    type Frame = { kind: "node"; node: unknown; pointer: string; sourcePointer: string }
        | { kind: "value"; value: unknown; pointer: string; sourcePointer: string }
        | { kind: "leave"; node: object };
    const pending: Frame[] = [{ kind: "node", node, pointer, sourcePointer }];
    const active = new WeakSet<object>();
    while (pending.length) {
        const frame = pending.pop()!;
        if (frame.kind === "leave") {
            active.delete(frame.node);
            continue;
        }
        if (frame.kind === "value") {
            pushIfViolation(frame.value, frame.pointer, frame.sourcePointer, ctx);
            continue;
        }
        if (frame.node === null || typeof frame.node !== "object") continue;
        if (active.has(frame.node)) {
            throw new NativeAccessorError("INVALID_DECLARATION", frame.sourcePointer, "Cyclic metadata object");
        }
        active.add(frame.node);
        pending.push({ kind: "leave", node: frame.node });
        const entries = Object.entries(frame.node);
        for (let index = entries.length - 1; index >= 0; index--) {
            const [key, value] = entries[index];
            const next = { pointer: `${frame.pointer}/${key}`, sourcePointer: appendPointer(frame.sourcePointer, key) };
            pending.push({ kind: "node", node: value, ...next });
            if (!Array.isArray(frame.node) && ctx.elementKeys.has(key)) {
                pending.push({ kind: "value", value, ...next });
            }
        }
    }
}

export function checkInternationalization(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!spec) return diagnostics;

    const locations: string[] = Array.isArray(rule?.location) ? rule.location : [];
    const elementArr: string[] = Array.isArray(rule?.element) ? rule.element : [];

    const params = rule?.call?.functionParams ?? rule?.functionParams ?? {};
    const forbiddenLanguages: string[] = Array.isArray(params?.forbiddenLanguages) ? params.forbiddenLanguages : ["zh"];

    const elementKeys = new Set<string>(elementArr.length ? elementArr : ["summary", "description", "title", "name"]);

    const ctx: WalkCtx = {
        diagnostics,
        content,
        rule,
        elementKeys,
        forbiddenLanguages,
    };

    // info
    if (locations.includes("info") && spec.info) {
        walkObject(spec.info, "/info", ctx);
    }

    // tags
    if (locations.includes("tags") && Array.isArray(spec.tags)) {
        walkObject(spec.tags, "/tags", ctx);
    }

    if (locations.includes("components")) {
        const sections = isSwagger2Root(spec) ? ["definitions", "parameters", "responses", "securityDefinitions"] : ["components"];
        for (const section of sections) {
            if (spec[section]) walkObject(spec[section], `/${section}`, ctx);
        }
    }

    return diagnostics;
}
