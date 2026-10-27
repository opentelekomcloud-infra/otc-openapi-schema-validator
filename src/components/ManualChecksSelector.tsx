'use client';

import React, { useState, useEffect } from "react";
import type { RulesetsStructure } from "@/utils/extract";
import { loadRuleCatalog } from "@/lib/linter/ruleCatalog";
import ReactMarkdown from "react-markdown";
import { ScaleCheckbox, ScaleSearch, ScaleSelect } from "@/components/ScaleControls";

export type ManualRule = {
    id: string;
    title: string;
    message: string;
    option?: string;
    verified?: boolean;
};

async function fetchAllManualRules(structure: RulesetsStructure): Promise<ManualRule[]> {
    const files = Object.values(structure).flat().map((file) => `/manual-checklist/${file}`);
    const rules = await loadRuleCatalog(files, async (file) => {
        const response = await fetch(file);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    });
    return rules.map((rule) => ({ ...rule, verified: false }));
}

const ManualChecksSelector = ({ onManualRulesChange }: {
    onManualRulesChange?: (manualRules: ManualRule[]) => void;
}) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [manualRules, setManualRules] = useState<ManualRule[]>([]);
    const [initialized, setInitialized] = useState(false);
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState("all");
    useEffect(() => {
        const storedRules = localStorage.getItem("manualRules");
        if (storedRules) {
            try {
                setManualRules(JSON.parse(storedRules));
            } catch (error: unknown) {
                console.error("Error parsing stored manual rules:", error);
                setError("Unable to restore the saved manual checklist.");
            }
        }
        setInitialized(true);
    }, []);
    useEffect(() => {
        if (!initialized) return;
        localStorage.setItem("manualRules", JSON.stringify(manualRules));
        onManualRulesChange?.(manualRules);
    }, [initialized, manualRules, onManualRulesChange]);
    useEffect(() => {
        if (!initialized) return;
        let cancelled = false;
        let refreshing = false;
        async function refresh() {
            if (refreshing) return;
            refreshing = true;
            try {
                const response = await fetch("/api/manuals");
                if (!response.ok) throw new Error(`Failed to fetch manual checks: HTTP ${response.status}`);
                const structure: RulesetsStructure = await response.json();
                const fetched = await fetchAllManualRules(structure);
                if (cancelled) return;
                setError("");
                setManualRules((previous) => {
                    const merged = fetched.map((rule) => ({
                        ...rule, verified: previous.find((entry) => entry.id === rule.id)?.verified ?? false,
                    }));
                    return JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged;
                });
            } catch (error: unknown) {
                if (cancelled) return;
                console.error("Failed to load manual checks", error);
                setError(error instanceof Error ? error.message : String(error));
            } finally {
                refreshing = false;
                if (!cancelled) setLoading(false);
            }
        }
        void refresh();
        const interval = setInterval(refresh, 30000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [initialized]);
    const visible = manualRules.filter((rule) =>
        (status === "all" || Boolean(rule.verified) === (status === "reviewed")) &&
        `${rule.id} ${rule.title} ${rule.message}`.toLowerCase().includes(query.trim().toLowerCase()));
    const updateFiltered = (verified: boolean) => {
        const ids = new Set(visible.map((rule) => rule.id));
        setManualRules((previous) => previous.map((rule) => ids.has(rule.id) ? { ...rule, verified } : rule));
    };
    return <div className="settingsPanel">
        <div className="panelToolbar">
            <div className="filterGrid settingsFilters">
                <ScaleSearch label="Search manual checks" value={query} onChange={setQuery} />
                <ScaleSelect label="Review status" value={status} onChange={setStatus} options={[
                    { value: "all", label: "All checks" }, { value: "pending", label: "Not reviewed" },
                    { value: "reviewed", label: "Reviewed" },
                ]} />
            </div>
            <div className="panelSummary">
                <span>{manualRules.filter((rule) => rule.verified).length}/{manualRules.length} reviewed</span>
                <div className="inlineActions">
                    <scale-button size="small" variant="secondary" disabled={loading || Boolean(error)}
                        onClick={() => updateFiltered(true)}>Mark filtered reviewed</scale-button>
                    <scale-button size="small" variant="secondary" disabled={loading || Boolean(error)}
                        onClick={() => updateFiltered(false)}>Reset filtered</scale-button>
                </div>
            </div>
            <p className="muted">Manual checks are reviewed separately; automatic validation does not mark them as passed.</p>
        </div>
        <div className="panelScroll">
            {error ? <p className="emptyState" role="alert">Error: {error}</p>
                : loading ? <p className="emptyState" role="status">Loading manual checks...</p>
                : <div className="ruleList">
                    {!visible.length && <p className="emptyState">No manual checks match the current filters.</p>}
                    {visible.map((rule) => <article key={rule.id} className="ruleCard" data-reviewed={Boolean(rule.verified)}>
                        <ScaleCheckbox label={`Review ${rule.id}`} checked={Boolean(rule.verified)} onChange={() =>
                            setManualRules((previous) => previous.map((entry) =>
                                entry.id === rule.id ? { ...entry, verified: !entry.verified } : entry))} />
                        <div className="ruleContent">
                            <div className="ruleMeta"><span className="ruleId">{rule.id}</span>
                                <span className="muted">{rule.verified ? "Reviewed" : "Not reviewed"} · {rule.option}</span></div>
                            <h3>{rule.title}</h3>
                            <details><summary>Check details</summary><ReactMarkdown>{rule.message}</ReactMarkdown></details>
                        </div>
                    </article>)}
                </div>}
        </div>
    </div>;
};

export default ManualChecksSelector;
