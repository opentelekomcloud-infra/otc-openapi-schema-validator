"use client";

import React, { useRef, useState } from "react";
import { exclusionReason, exclusionRuleId, type IssueExclusion, type RuleExclusion } from "@/lib/linter/issueExclusions";

type Props = {
    ruleset: string;
    excludedRules: readonly RuleExclusion[];
    excludedManualRules?: readonly RuleExclusion[];
    excludedIssues: readonly IssueExclusion[];
    onRuleReasonChange?: (id: string, reason: string) => void;
    onManualReasonChange?: (id: string, reason: string) => void;
    onIssueReasonChange?: (exclusion: IssueExclusion, reason: string) => void;
    onUnmute: (exclusion: IssueExclusion) => void;
    onUnmuteAll: () => void;
};

export default function ExclusionsExport({
    ruleset, excludedRules, excludedManualRules, excludedIssues, onRuleReasonChange,
    onManualReasonChange, onIssueReasonChange, onUnmute, onUnmuteAll,
}: Props) {
    const [copyStatus, setCopyStatus] = useState("");
    const [copyError, setCopyError] = useState("");
    const jsonRef = useRef<HTMLTextAreaElement>(null);
    const json = JSON.stringify({
        ruleset, exclude_auto_rules: excludedRules, exclude_issues: excludedIssues,
        ...(excludedManualRules === undefined ? {} : { exclude_manual_rules: excludedManualRules }),
    }, null, 2);
    const copy = async () => {
        setCopyStatus("");
        setCopyError("");
        try {
            await navigator.clipboard.writeText(json);
            setCopyStatus("Exclusions copied.");
        } catch (error: unknown) {
            console.error("Unable to copy API exclusions", error);
            setCopyError("Unable to copy. Select and copy the JSON below manually.");
        }
    };
    const ruleReasons = (category: "automatic" | "manual", entries: readonly RuleExclusion[],
        change?: (id: string, reason: string) => void) => entries.length > 0 && <>
        <h3>Excluded {category} rules</h3>
        <div className="exclusionsTableScroll"><div className="mutedIssuesScroll">
            <table className="workspaceTable exclusionReasonsTable">
            <thead><tr><th scope="col">Rule</th><th scope="col">Reason (optional)</th></tr></thead>
            <tbody>{entries.map((entry) => {
                const id = exclusionRuleId(entry);
                return <tr key={id}><td><span className="ruleId">{id}</span></td>
                    <td><textarea className="exclusionsJson exclusionReason" rows={1}
                        aria-label={`Exclusion reason for ${category} ${id}`} value={exclusionReason(entry)} readOnly={!change}
                        onChange={(event) => { setCopyStatus(""); change?.(id, event.target.value); }} /></td></tr>;
            })}</tbody>
        </table></div></div>
    </>;
    return <>
        <p>Merge these fields into your API validation request and add path or file_content.
            All unchecked automatic rules, including optional rules, are excluded.
            Manual checks are excluded only by an explicit exclusion, not their reviewed status.</p>
        <p className="muted">Muting applies to all findings for the same rule and source line.
            Issue mutes reset when the specification text or ruleset changes, or a file is loaded.</p>
        <p>{excludedRules.length} excluded automatic rules · {excludedIssues.length} muted rule/line pairs</p>
        <textarea ref={jsonRef} className="exclusionsJson" aria-label="API exclusions JSON" readOnly value={json} rows={12} />
        <scale-button variant="secondary" onClick={copy}>Copy JSON</scale-button>
        {copyStatus && <p role="status">{copyStatus}</p>}
        {copyError && <p role="alert">{copyError}</p>}
        {ruleReasons("automatic", excludedRules, onRuleReasonChange)}
        {ruleReasons("manual", excludedManualRules ?? [], onManualReasonChange)}
        {excludedIssues.length > 0 && <>
            <h3>Muted issues</h3>
            <div className="exclusionsTableScroll"><div className="mutedIssuesScroll mutedIssuesViewport">
                <table className="workspaceTable mutedIssuesTable">
                    <caption className="visuallyHidden">Muted issues</caption>
                    <thead><tr><th scope="col">Rule</th><th scope="col">Line</th>
                        <th scope="col">Reason (optional)</th><th scope="col">Unmute</th></tr></thead>
                    <tbody>{excludedIssues.map((entry) =>
                        <tr key={`${entry.rule_id}:${entry.line_number}`}>
                            <td><span className="ruleId">{entry.rule_id}</span></td>
                            <td>{entry.line_number}</td>
                            <td><textarea className="exclusionsJson exclusionReason" rows={1}
                                aria-label={`Exclusion reason for ${entry.rule_id} on line ${entry.line_number}`}
                                value={entry.reason ?? ""} readOnly={!onIssueReasonChange}
                                onChange={(event) => { setCopyStatus(""); onIssueReasonChange?.(entry, event.target.value); }} /></td>
                            <td><button className="textAction mutedIssueAction" onClick={() => {
                                setCopyStatus("");
                                jsonRef.current?.focus({ preventScroll: true });
                                onUnmute(entry);
                            }} title="Unmute this rule on this line"
                                aria-label={`Unmute ${entry.rule_id} on line ${entry.line_number}`}>
                                <scale-icon-action-show-password aria-hidden="true" />
                            </button></td>
                        </tr>)}</tbody>
                </table>
            </div></div>
            <scale-button variant="secondary" onClick={() => {
                setCopyStatus("");
                jsonRef.current?.focus({ preventScroll: true });
                onUnmuteAll();
            }}><span className="buttonIconLabel"><scale-icon-action-show-password aria-hidden="true" />
                <span>Unmute all issues</span></span></scale-button>
        </>}
    </>;
}
