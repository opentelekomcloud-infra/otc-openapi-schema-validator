import type { Diagnostic } from "@codemirror/lint";
import { diagnosticRuleId, isDocumentError, isSkippedRule } from "@/lib/export/ruleOutcomes";
import { diagnosticLineNumber } from "@/lib/openapi/sourceMap";

export interface IssueExclusion {
    rule_id: string;
    line_number: number;
    reason?: string;
}

export type RuleExclusion = string | { rule_id: string; reason?: string };

export interface ApiExclusions {
    ruleset: string;
    exclude_auto_rules: RuleExclusion[];
    exclude_manual_rules?: RuleExclusion[];
    exclude_issues: IssueExclusion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exclusionRuleId(entry: RuleExclusion): string {
    return typeof entry === "string" ? entry : entry.rule_id;
}

export function exclusionReason(entry: RuleExclusion): string {
    return typeof entry === "string" ? "" : entry.reason ?? "";
}

export function ruleExclusion(id: string, reason = ""): RuleExclusion {
    return reason ? { rule_id: id, reason } : id;
}

function reasonValue(value: unknown): string | undefined {
    if (value !== undefined && typeof value !== "string") throw new Error("Exclusion reason must be a string.");
    return typeof value === "string" ? value.trim() || undefined : undefined;
}

function mergeReason(previous: string | undefined, incoming: string | undefined, key: string): string | undefined {
    if (previous && incoming && previous !== incoming) throw new Error(`Conflicting exclusion reasons for ${key}.`);
    return incoming ?? previous;
}

export function parseRuleExclusions(value: unknown, field: string): RuleExclusion[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${field} must be an array of rule IDs or { rule_id, reason } objects.`);
    const entries = new Map<string, RuleExclusion>();
    for (const entry of value) {
        const id = typeof entry === "string" ? entry : isRecord(entry) ? entry.rule_id : undefined;
        if (typeof id !== "string" || !id.trim() || (isRecord(entry) &&
            Object.keys(entry).some((key) => !["rule_id", "reason"].includes(key)))) {
            throw new Error(`Each ${field} entry must be a non-empty rule ID or { rule_id, reason } object.`);
        }
        const reason = isRecord(entry) ? reasonValue(entry.reason) : undefined;
        const key = id.trim();
        const previous = entries.get(key);
        entries.set(key, ruleExclusion(key, mergeReason(previous ? exclusionReason(previous) || undefined : undefined, reason, key)));
    }
    return [...entries.values()];
}

export function parseIssueExclusions(value: unknown): IssueExclusion[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("exclude_issues must be an array of rule/line pairs.");
    const entries = new Map<string, IssueExclusion>();
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.rule_id !== "string" || !entry.rule_id.trim() ||
            typeof entry.line_number !== "number" || !Number.isSafeInteger(entry.line_number) || entry.line_number <= 0 ||
            Object.keys(entry).some((key) => !["rule_id", "line_number", "reason"].includes(key))) {
            throw new Error("Each exclude_issues entry must contain a non-empty rule_id and a positive integer line_number.");
        }
        const rule_id = entry.rule_id.trim();
        const key = JSON.stringify([rule_id, entry.line_number]);
        const reason = mergeReason(entries.get(key)?.reason, reasonValue(entry.reason), `${rule_id} on line ${entry.line_number}`);
        entries.set(key, { rule_id, line_number: entry.line_number, ...(reason ? { reason } : {}) });
    }
    return [...entries.values()];
}

export function parseApiExclusions(json: string): ApiExclusions {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) throw new Error("Expected an API exclusions JSON object.");
    const unknownFields = Object.keys(value).filter((key) =>
        !["ruleset", "exclude_auto_rules", "exclude_manual_rules", "exclude_issues"].includes(key));
    if (unknownFields.length) throw new Error(`Unknown exclusions fields: ${unknownFields.join(", ")}.`);
    if (typeof value.ruleset !== "string" || !value.ruleset.trim()) throw new Error("ruleset must be a non-empty string.");
    return {
        ruleset: value.ruleset.trim(),
        exclude_auto_rules: parseRuleExclusions(value.exclude_auto_rules, "exclude_auto_rules"),
        ...(value.exclude_manual_rules === undefined ? {} : {
            exclude_manual_rules: parseRuleExclusions(value.exclude_manual_rules, "exclude_manual_rules"),
        }),
        exclude_issues: parseIssueExclusions(value.exclude_issues),
    };
}

export function validateExclusionRuleIds(
    exclusions: ApiExclusions, rules: readonly { id: string }[], manualRules: readonly { id: string }[] = [],
): void {
    const known = new Set(rules.map((rule) => rule.id));
    const unknown = exclusions.exclude_auto_rules.map(exclusionRuleId).filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown automatic rule IDs in ruleset "${exclusions.ruleset}": ${unknown.join(", ")}.`);
    const manualIds = new Set(manualRules.map((rule) => rule.id));
    const unknownManual = (exclusions.exclude_manual_rules ?? []).map(exclusionRuleId).filter((id) => !manualIds.has(id));
    if (unknownManual.length) throw new Error(`Unknown manual rule IDs: ${unknownManual.join(", ")}.`);
}

export function issueExclusionFor(content: string, diagnostic: Diagnostic): IssueExclusion | undefined {
    if (isDocumentError(diagnostic) || isSkippedRule(diagnostic)) return undefined;
    const rule_id = diagnosticRuleId(diagnostic);
    const line_number = diagnosticLineNumber(content, diagnostic);
    return rule_id && typeof line_number === "number" ? { rule_id, line_number } : undefined;
}

export function sameIssueExclusion(a: IssueExclusion, b: IssueExclusion): boolean {
    return a.rule_id === b.rule_id && a.line_number === b.line_number;
}

export function isIssueExcluded(content: string, diagnostic: Diagnostic, exclusions: readonly IssueExclusion[]): boolean {
    if (!exclusions.length) return false;
    const selector = issueExclusionFor(content, diagnostic);
    return Boolean(selector && exclusions.some((entry) => sameIssueExclusion(entry, selector)));
}
