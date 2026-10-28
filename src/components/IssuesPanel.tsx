"use client";

import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Diagnostic } from "@codemirror/lint";
import { diagnosticRuleId } from "@/lib/export/ruleOutcomes";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import { getSeverityLabel, severityToDiagnosticMap } from "@/utils/mapSeverity";
import { ScaleDialog, ScaleSearch, ScaleSelect } from "./ScaleControls";

export interface IssuesPanelHandle {
    reveal: (diagnostic: Diagnostic) => void;
}

type Props = {
    diagnostics: readonly Diagnostic[];
    content: string;
    isLinting: boolean;
    lintError: string | null;
    hasDocument: boolean;
    rulesSelected: number;
    onNavigate: (diagnostic: Diagnostic) => void;
    onConfigureRules: () => void;
};
const pageSize = 100;
const severityOptions = ["all", "critical", "high", "medium", "low"].map((value) => ({
    value, label: value === "all" ? "All severities" : value[0].toUpperCase() + value.slice(1),
}));
const rank: Record<string, number> = { error: 3, warning: 2, info: 1, hint: 0 };

const IssuesPanel = forwardRef<IssuesPanelHandle, Props>(function IssuesPanel({
    diagnostics, content, isLinting, lintError, hasDocument, rulesSelected, onNavigate, onConfigureRules,
}, ref) {
    const [query, setQuery] = useState("");
    const [severity, setSeverity] = useState("all");
    const [groupBy, setGroupBy] = useState("none");
    const [sort, setSort] = useState("severity");
    const [page, setPage] = useState(0);
    const [active, setActive] = useState<Diagnostic | null>(null);
    const [detail, setDetail] = useState<Diagnostic | null>(null);
    const rows = useRef(new Map<Diagnostic, HTMLTableRowElement>());
    const lineStarts = useMemo(() => {
        const starts = [0];
        for (let index = 0; index < content.length; index++) {
            if (content[index] === "\n") starts.push(index + 1);
        }
        return starts;
    }, [content]);
    const line = (diagnostic: Diagnostic) => {
        // Binary search avoids rescanning a large specification for every visible issue.
        let low = 0, high = lineStarts.length;
        while (low + 1 < high) {
            const middle = Math.floor((low + high) / 2);
            if (lineStarts[middle] <= diagnostic.from) low = middle;
            else high = middle;
        }
        return low + 1;
    };
    const filtered = useMemo(() => {
        const search = query.trim().toLowerCase();
        return diagnostics.filter((diagnostic) =>
            (severity === "all" || diagnostic.severity === severityToDiagnosticMap[severity]) &&
            (!search || `${diagnostic.source ?? ""} ${diagnostic.message}`.toLowerCase().includes(search)))
            .sort((a, b) => sort === "line" ? a.from - b.from
                : sort === "rule" ? (diagnosticRuleId(a) ?? a.source ?? "").localeCompare(diagnosticRuleId(b) ?? b.source ?? "")
                : (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) || a.from - b.from);
    }, [diagnostics, query, severity, sort]);
    const maxPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
    const currentPage = Math.min(page, maxPage);
    const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    const groups = new Map<string, Diagnostic[]>();
    for (const diagnostic of visible) {
        const key = groupBy === "rule" ? diagnosticRuleId(diagnostic) ?? diagnostic.source ?? "Other"
            : groupBy === "line" ? `Line ${line(diagnostic)}` : "";
        const entries = groups.get(key) ?? [];
        entries.push(diagnostic);
        groups.set(key, entries);
    }
    useEffect(() => {
        setActive(null);
        setDetail(null);
        setPage(0);
    }, [diagnostics]);
    const changeFilter = (setValue: (value: string) => void) => (value: string) => {
        setValue(value);
        setPage(0);
    };
    useEffect(() => {
        if (active) rows.current.get(active)?.scrollIntoView?.({ block: "nearest" });
    }, [active, currentPage, groupBy]);
    useImperativeHandle(ref, () => ({
        reveal(diagnostic) {
            setQuery("");
            setSeverity("all");
            setSort("line");
            setGroupBy("none");
            const ordered = [...diagnostics].sort((a, b) => a.from - b.from);
            setPage(Math.max(0, Math.floor(ordered.indexOf(diagnostic) / pageSize)));
            setActive(diagnostic);
        },
    }), [diagnostics]);
    const select = (diagnostic: Diagnostic) => {
        setActive(diagnostic);
        onNavigate(diagnostic);
    };
    const activeIndex = active ? filtered.indexOf(active) : -1;
    const move = (offset: number) => {
        const index = activeIndex < 0 ? (offset > 0 ? 0 : filtered.length - 1)
            : (activeIndex + offset + filtered.length) % filtered.length;
        const diagnostic = filtered[index];
        if (!diagnostic) return;
        setPage(Math.floor(index / pageSize));
        select(diagnostic);
    };
    let empty: React.ReactNode;
    if (isLinting) empty = <p role="status">Validating specification...</p>;
    else if (lintError) empty = <p role="alert">{lintError}</p>;
    else if (!diagnostics.length && !hasDocument) empty = <>
        <h2>Start with a specification</h2><p>Load a YAML file or paste it into the editor.</p>
    </>;
    else if (!diagnostics.length && !rulesSelected) empty = <>
        <h2>Choose rules to validate</h2><p>No automatic checks are selected. This is not a successful validation.</p>
        <scale-button variant="secondary" onClick={onConfigureRules}>Configure rules</scale-button>
    </>;
    else if (!diagnostics.length) empty = <><h2>No lint issues.</h2><p>The selected automatic checks found no issues. Manual checks are reviewed separately.</p></>;
    else if (!filtered.length) empty = <><h2>No matching issues</h2><p>Other issues are hidden by the current filters.</p>
        <scale-button variant="secondary" onClick={() => { setQuery(""); setSeverity("all"); }}>Clear filters</scale-button>
    </>;

    return <div className="issuesPanel">
        <div className="panelToolbar">
            <div className="filterGrid">
                <ScaleSearch label="Search issues" value={query} onChange={changeFilter(setQuery)} />
                <ScaleSelect label="Severity" value={severity} options={severityOptions} onChange={changeFilter(setSeverity)} />
                <ScaleSelect label="Group by" value={groupBy} onChange={changeFilter(setGroupBy)} options={[
                    { value: "none", label: "No grouping" }, { value: "rule", label: "Rule" }, { value: "line", label: "Line" },
                ]} />
                <ScaleSelect label="Sort by" value={sort} onChange={changeFilter(setSort)} options={[
                    { value: "severity", label: "Severity" }, { value: "line", label: "Line" }, { value: "rule", label: "Rule" },
                ]} />
            </div>
            <div className="panelSummary">
                <span role="status">{isLinting ? "Results pending" : `${filtered.length} of ${diagnostics.length} issues`}</span>
                <div className="inlineActions">
                    <scale-button variant="secondary" size="small" disabled={!filtered.length || isLinting || Boolean(lintError)}
                        onClick={() => move(-1)}>Previous issue</scale-button>
                    <scale-button variant="secondary" size="small" disabled={!filtered.length || isLinting || Boolean(lintError)}
                        onClick={() => move(1)}>Next issue</scale-button>
                </div>
            </div>
        </div>
        <div className="panelScroll" aria-label="Validation results">
            {empty ? <div className="emptyState">{empty}</div> : [...groups].map(([key, entries]) =>
                <section key={key} className="issueGroup">
                    {key && <h3 className="issueGroupHeading">{key} <span>({entries.length} on this page)</span></h3>}
                    <table className="workspaceTable issuesTable">
                        <caption className="visuallyHidden">{key || "Lint issues"}</caption>
                        <thead><tr><th scope="col">Line</th><th scope="col">Rule</th><th scope="col">Issue</th>
                            <th scope="col">Severity</th><th scope="col"><span className="visuallyHidden">Details</span></th></tr></thead>
                        <tbody>{entries.map((diagnostic) => <tr key={diagnostics.indexOf(diagnostic)}
                            ref={(element) => { if (element) rows.current.set(diagnostic, element); else rows.current.delete(diagnostic); }}
                            data-active={active === diagnostic}
                            aria-selected={active === diagnostic}
                            onClick={() => select(diagnostic)}>
                            <td><button className="textAction" onClick={(event) => {
                                event.stopPropagation(); select(diagnostic);
                            }} aria-label={`Go to line ${line(diagnostic)}`}>{line(diagnostic)}</button></td>
                            <td><span className="ruleId" title={diagnostic.source}>{diagnosticRuleId(diagnostic) ?? diagnostic.source ?? "Document"}</span></td>
                            <td><span className="issuePreview" title={diagnostic.message}>{diagnostic.message}</span></td>
                            <td><span className="severityLabel" data-severity={diagnostic.severity}>
                                <span aria-hidden="true" className="severityDot" />{getSeverityLabel(diagnostic.severity)}</span></td>
                            <td><button className="textAction" onClick={(event) => {
                                event.stopPropagation(); setDetail(diagnostic);
                            }} aria-label={`Details for issue on line ${line(diagnostic)}`}>Details</button></td>
                        </tr>)}</tbody>
                    </table>
                </section>)}
        </div>
        {!empty && filtered.length > pageSize && <nav className="pagination" aria-label="Issue pages">
            <scale-button variant="secondary" size="small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</scale-button>
            <span>Page {currentPage + 1} of {maxPage + 1} · {pageSize} per page</span>
            <scale-button variant="secondary" size="small" disabled={currentPage === maxPage} onClick={() => setPage(currentPage + 1)}>Next page</scale-button>
        </nav>}
        {detail && <ScaleDialog heading="Issue details" onClose={() => setDetail(null)}>
            <p className="muted">{detail.source} · Line {sourceLineNumber(content, detail.from)} · {getSeverityLabel(detail.severity)}</p>
            <p className="fullMessage">{detail.message}</p>
            <scale-button slot="action" variant="secondary" onClick={() => { select(detail); setDetail(null); }}>Go to source</scale-button>
        </ScaleDialog>}
    </div>;
});

export default IssuesPanel;
