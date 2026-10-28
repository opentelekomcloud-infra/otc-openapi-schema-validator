'use client';

import React, { useState, useEffect } from "react";
import type { RulesetsStructure } from "@/utils/extract";
import type { AutoRule } from "@/lib/linter/ruleCatalog";
import { getImplementedRules, loadRuleCatalog } from "@/lib/linter/ruleCatalog";
import { functionsMap } from "@/lib/linter/runLinter";
import { ScaleCheckbox, ScaleSearch, ScaleSelect } from "@/components/ScaleControls";

export type Rule = AutoRule;

type RulesetsSelectorProps = {
    onSelectionChange?: (selectedRules: Rule[]) => void;
    onTotalRulesChange?: (total: number) => void;
    onRulesetChange?: (name: string) => void;
};

const RulesetsSelector = ({ onSelectionChange, onTotalRulesChange, onRulesetChange }: RulesetsSelectorProps) => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [rulesLoading, setRulesLoading] = useState(false);

    const [selectedRuleset, setSelectedRuleset] = useState<string>("");
    const [allRules, setAllRules] = useState<Rule[]>([]);
    const [selectedRules, setSelectedRules] = useState<Rule[]>([]);
    const [severityFilter, setSeverityFilter] = useState<string>("all");

    const [query, setQuery] = useState("");

    useEffect(() => {
        async function fetchRulesets() {
            try {
                const res = await fetch("/api/rulesets");
                if (!res.ok) {
                    throw new Error(`Failed to fetch rulesets: HTTP ${res.status}`);
                }
                const data: RulesetsStructure = await res.json();
                setRulesets(data);
            } catch (err: unknown) {
                console.error("Failed to fetch rulesets", err);
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setLoading(false);
            }
        }
        fetchRulesets();
    }, []);

    useEffect(() => {
        let cancelled = false;
        setAllRules([]);
        setSelectedRules([]);
        onTotalRulesChange?.(0);
        onSelectionChange?.([]);
        setError("");
        setRulesLoading(Boolean(selectedRuleset));

        async function fetchAllRules() {
            try {
                const fileNames = rulesets[selectedRuleset];
                if (!fileNames) throw new Error(`Unknown ruleset: ${selectedRuleset}`);
                const files = fileNames.map((file) => `/rulesets/${selectedRuleset}/${file}.yaml`);
                const rules = await loadRuleCatalog(files, async (file) => {
                    const response = await fetch(file);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.text();
                });
                const implementedRules = getImplementedRules(rules, functionsMap);
                if (cancelled) return;
                setAllRules(implementedRules);
                onTotalRulesChange?.(implementedRules.length);

                const mandatoryRules = implementedRules.filter(
                    (rule) => rule.option.toLowerCase() === "mandatory"
                );
                setSelectedRules(mandatoryRules);
                onSelectionChange?.(mandatoryRules);
            } catch (error: unknown) {
                if (cancelled) return;
                console.error("Failed to load ruleset", error);
                setError(error instanceof Error ? error.message : String(error));
            } finally {
                if (!cancelled) setRulesLoading(false);
            }
        }

        if (selectedRuleset) fetchAllRules();
        return () => { cancelled = true; };
    }, [selectedRuleset, rulesets, onSelectionChange, onTotalRulesChange]);

    const handleRulesetChange = (value: string) => {
        setSelectedRuleset(value);
        onRulesetChange?.(value);
        setSeverityFilter("all");
        setQuery("");
    };

    const handleRuleToggle = (rule: Rule) => {
        const exists = selectedRules.find((r) => r.id === rule.id);
        const updated = exists
            ? selectedRules.filter((r) => r.id !== rule.id)
            : [...selectedRules, rule];
        setSelectedRules(updated);
        if (onSelectionChange) onSelectionChange(updated);
    };

    const handleSelectAll = () => {
        const filtered = applySeverityFilter(allRules);
        const selected = new Set(selectedRules.map((rule) => rule.id));
        const updated = [...selectedRules, ...filtered.filter((rule) => !selected.has(rule.id))];
        setSelectedRules(updated);
        onSelectionChange?.(updated);
    };

    const handleDeselectAll = () => {
        const visible = new Set(applySeverityFilter(allRules).map((rule) => rule.id));
        const updated = selectedRules.filter((rule) => !visible.has(rule.id));
        setSelectedRules(updated);
        onSelectionChange?.(updated);
    };

    const applySeverityFilter = (rules: Rule[], filter = severityFilter): Rule[] => {
        const search = query.trim().toLowerCase();
        return rules.filter((rule) => (filter === "all" || rule.severity === filter) &&
            (!search || `${rule.id} ${rule.title} ${rule.message}`.toLowerCase().includes(search)));
    };

    if (loading) return <p>Loading rulesets...</p>;

    const visibleRules = applySeverityFilter(allRules);
    const visibleIds = new Set(visibleRules.map((rule) => rule.id));
    const hiddenSelected = selectedRules.filter((rule) => !visibleIds.has(rule.id)).length;
    return <div className="settingsPanel">
        <div className="panelToolbar">
            <ScaleSelect label="Ruleset" value={selectedRuleset} onChange={handleRulesetChange}
                options={[{ value: "", label: "Select a ruleset" },
                    ...Object.keys(rulesets).map((value) => ({ value, label: value }))]} />
            {selectedRuleset && <div className="filterGrid settingsFilters">
                <ScaleSearch label="Search rules" value={query} onChange={setQuery} />
                <ScaleSelect label="Rule severity" value={severityFilter} onChange={setSeverityFilter}
                    options={["all", "critical", "high", "medium", "low"].map((value) => ({
                        value, label: value === "all" ? "All severities" : value[0].toUpperCase() + value.slice(1),
                    }))} />
            </div>}
            {selectedRuleset && !rulesLoading && !error && <div className="panelSummary">
                <span>{visibleRules.length} visible · {selectedRules.length} selected
                    {hiddenSelected > 0 && ` · ${hiddenSelected} selected outside filter`}</span>
                <div className="inlineActions">
                    <scale-button size="small" variant="secondary" onClick={handleSelectAll}>Select filtered</scale-button>
                    <scale-button size="small" variant="secondary" onClick={handleDeselectAll}>Clear filtered</scale-button>
                </div>
            </div>}
        </div>
        <div className="panelScroll">
            {error && <div className="emptyState" role="alert">Error: {error}</div>}
            {rulesLoading && <p className="emptyState" role="status">Loading rules...</p>}
            {!selectedRuleset && <div className="emptyState"><h2>Configure automatic checks</h2>
                <p>Select a ruleset. Mandatory checks are selected initially; optional checks can be added.</p></div>}
            {selectedRuleset && !rulesLoading && !error && <div className="ruleList">
                {!visibleRules.length && <p className="emptyState">No rules match the current filters.</p>}
                {visibleRules.map((rule) => <article key={rule.id} className="ruleCard">
                    <ScaleCheckbox label={`Select ${rule.id}`} checked={selectedRules.some((entry) => entry.id === rule.id)}
                        onChange={() => handleRuleToggle(rule)} />
                    <div className="ruleContent"><div className="ruleMeta"><span className="ruleId">{rule.id}</span>
                        <span className="muted">{rule.option} · {rule.severity}</span></div>
                        <h3>{rule.title}</h3>
                        <details><summary>Rule details</summary><p className="fullMessage">{rule.message}</p></details>
                    </div>
                </article>)}
            </div>}
        </div>
    </div>;
};

export default RulesetsSelector;
