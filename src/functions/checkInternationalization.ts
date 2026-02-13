import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { violatingIndexRange } from "@/utils/pos";
import {getSource} from "@/functions/common";

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

function pushIfViolation(value: unknown, pointer: string, ctx: WalkCtx) {
    if (typeof value !== "string" || !value.trim()) return;

    // Currently we only implement forbiddenLanguages: ['zh'] by detecting Chinese characters.
    // If 'zh' is not in forbiddenLanguages, we do nothing.
    if (!ctx.forbiddenLanguages.map((x) => String(x).toLowerCase()).includes("zh")) return;

    const range = typeof ctx.rule?.call?.functionParams?.forbiddenUnicodeRange === "string"
        ? ctx.rule.call.functionParams.forbiddenUnicodeRange
        : DEFAULT_CHINESE_UNICODE_RANGE;

    const forbiddenRe = new RegExp(`[${range}]`);

    if (!containsForbiddenChars(value, forbiddenRe)) return;

    const { from, to } = violatingIndexRange(ctx.content, pointer, value, forbiddenRe, pointer.length);
    ctx.diagnostics.push({
        from,
        to,
        severity: mapSeverity(ctx.rule.severity),
        message: `Non-English (Chinese) text detected at ${pointer}. Only English is allowed for this field.`,
        source: getSource(ctx.rule),
    });
}

function walkObject(node: any, pointer: string, ctx: WalkCtx) {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            walkObject(node[i], `${pointer}/${i}`, ctx);
        }
        return;
    }

    for (const [k, v] of Object.entries(node)) {
        const nextPtr = `${pointer}/${k}`;

        if (ctx.elementKeys.has(k)) {
            pushIfViolation(v, nextPtr, ctx);
        }

        // Continue traversal for nested objects
        if (v && typeof v === "object") {
            walkObject(v, nextPtr, ctx);
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

    // components (deep)
    if (locations.includes("components") && spec.components) {
        walkObject(spec.components, "/components", ctx);
    }

    return diagnostics;
}
