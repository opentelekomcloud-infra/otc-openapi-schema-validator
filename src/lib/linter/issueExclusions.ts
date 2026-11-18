import type { Diagnostic } from "@codemirror/lint";
import { diagnosticRuleId, isDocumentError, isSkippedRule } from "@/lib/export/ruleOutcomes";
import { diagnosticLineNumber } from "@/lib/openapi/sourceMap";

export interface IssueExclusion {
    rule_id: string;
    line_number: number;
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
