import type { Diagnostic } from "@codemirror/lint";
import { diagnosticRuleId, isDocumentError, isSkippedRule } from "@/lib/export/ruleOutcomes";
import { diagnosticLineNumber } from "@/lib/openapi/sourceMap";

export interface IssueExclusion {
    rule_id: string;
    line_number: number;
}

export interface ApiExclusions {
    ruleset: string;
    exclude_auto_rules: string[];
    exclude_issues: IssueExclusion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseApiExclusions(json: string): ApiExclusions {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) throw new Error("Expected an API exclusions JSON object.");
    const unknownFields = Object.keys(value).filter((key) => !["ruleset", "exclude_auto_rules", "exclude_issues"].includes(key));
    if (unknownFields.length) throw new Error(`Unknown exclusions fields: ${unknownFields.join(", ")}.`);
    if (typeof value.ruleset !== "string" || !value.ruleset.trim()) {
        throw new Error("ruleset must be a non-empty string.");
    }
    const rules: unknown = value.exclude_auto_rules === undefined ? [] : value.exclude_auto_rules;
    if (!Array.isArray(rules)) {
        throw new Error("exclude_auto_rules must be an array of non-empty rule IDs.");
    }
    const excludedRules = new Set<string>();
    for (const id of rules) {
        if (typeof id !== "string" || !id.trim()) {
            throw new Error("exclude_auto_rules must be an array of non-empty rule IDs.");
        }
        excludedRules.add(id.trim());
    }
    const issues: unknown = value.exclude_issues === undefined ? [] : value.exclude_issues;
    if (!Array.isArray(issues)) throw new Error("exclude_issues must be an array of rule/line pairs.");
    const excludedIssues: IssueExclusion[] = [];
    const seenIssues = new Set<string>();
    for (const entry of issues) {
        if (!isRecord(entry) || typeof entry.rule_id !== "string" || !entry.rule_id.trim() ||
            typeof entry.line_number !== "number" || !Number.isSafeInteger(entry.line_number) || entry.line_number <= 0 ||
            Object.keys(entry).some((key) => !["rule_id", "line_number"].includes(key))) {
            throw new Error("Each exclude_issues entry must contain a non-empty rule_id and a positive integer line_number.");
        }
        const rule_id = entry.rule_id.trim();
        const key = JSON.stringify([rule_id, entry.line_number]);
        if (!seenIssues.has(key)) {
            seenIssues.add(key);
            excludedIssues.push({ rule_id, line_number: entry.line_number });
        }
    }
    return {
        ruleset: value.ruleset.trim(),
        exclude_auto_rules: [...excludedRules],
        exclude_issues: excludedIssues,
    };
}

export function validateExclusionRuleIds(exclusions: ApiExclusions, rules: readonly { id: string }[]): void {
    const known = new Set(rules.map((rule) => rule.id));
    const unknown = exclusions.exclude_auto_rules.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown automatic rule IDs in ruleset "${exclusions.ruleset}": ${unknown.join(", ")}.`);
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
