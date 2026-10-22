'use client';

import React, { useState, useEffect } from "react";
import type { RulesetsStructure } from "@/utils/extract";
import type { AutoRule } from "@/lib/linter/ruleCatalog";
import { getImplementedRules, loadRuleCatalog } from "@/lib/linter/ruleCatalog";
import { functionsMap } from "@/lib/linter/runLinter";
import styles from "@/components/Table.module.css";

export type Rule = AutoRule;

type RulesetsSelectorProps = {
    onSelectionChange?: (selectedRules: Rule[]) => void;
    onTotalRulesChange?: (total: number) => void;
};

const RulesetsSelector = ({ onSelectionChange, onTotalRulesChange }: RulesetsSelectorProps) => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [rulesLoading, setRulesLoading] = useState(false);

    const [selectedRuleset, setSelectedRuleset] = useState<string>("");
    const [allRules, setAllRules] = useState<Rule[]>([]);
    const [selectedRules, setSelectedRules] = useState<Rule[]>([]);
    const [severityFilter, setSeverityFilter] = useState<string>("all");

    const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);
    const [activeMessage, setActiveMessage] = useState<string>("");

    const MESSAGE_PREVIEW_LIMIT = 100;

    const openMessageModal = (message: string) => {
        setActiveMessage(message ?? "");
        setIsMessageModalOpen(true);
    };

    const closeMessageModal = () => {
        setIsMessageModalOpen(false);
        setActiveMessage("");
    };

    const renderMessageCell = (message: string) => {
        const safe = message ?? "";
        const needsTruncate = safe.length > MESSAGE_PREVIEW_LIMIT;
        const preview = needsTruncate ? safe.slice(0, MESSAGE_PREVIEW_LIMIT) : safe;

        return (
            <span>
                {preview}
                {needsTruncate && (
                    <button
                        type="button"
                        onClick={() => openMessageModal(safe)}
                        className="ml-2 underline text-gray-600 hover:text-gray-800"
                    >
                        ..show more
                    </button>
                )}
            </span>
        );
    };

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

    const handleRulesetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedRuleset(e.target.value);
        setSeverityFilter("all");
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
        setSelectedRules(filtered);
        if (onSelectionChange) onSelectionChange(filtered);
    };

    const handleDeselectAll = () => {
        setSelectedRules([]);
        if (onSelectionChange) onSelectionChange([]);
    };

    const handleSeverityFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        setSeverityFilter(value);
        const filtered = applySeverityFilter(allRules, value);
        setSelectedRules(filtered);
        if (onSelectionChange) onSelectionChange(filtered);
    };

    const applySeverityFilter = (rules: Rule[], filter = severityFilter): Rule[] => {
        return filter === "all" ? rules : rules.filter((rule) => rule.severity === filter);
    };

    if (loading) return <p>Loading rulesets...</p>;

    const rulesetNames = Object.keys(rulesets);
    const visibleRules = applySeverityFilter(allRules);

    return (
        <div>
            <div className="mb-4">
                <label className="block mb-1 font-semibold">Select Ruleset</label>
                <select
                    value={selectedRuleset}
                    onChange={handleRulesetChange}
                    className="w-full border p-2 rounded-md"
                >
                    <option value="">-- Select a ruleset --</option>
                    {rulesetNames.map((ruleset) => (
                        <option key={ruleset} value={ruleset}>
                            {ruleset}
                        </option>
                    ))}
                </select>
            </div>
            {error && <p role="alert">Error: {error}</p>}
            {rulesLoading && <p role="status">Loading rules...</p>}
            {selectedRuleset && !rulesLoading && !error && (
                <>
                    <div className="flex items-center space-x-4 mb-2">
                        <scale-button
                          onClick={handleSelectAll}
                          variant="primary"
                          size="m"
                        >
                            Select All
                        </scale-button>
                        <scale-button
                          onClick={handleDeselectAll}
                          variant="secondary"
                          size="m"
                          style={{
                            ['--background-secondary' as any]: '#ffffff',
                            ['--background-secondary-hover' as any]: 'hsla(0, 0%, 0%, 0.07)',
                            ['--background-secondary-active' as any]: 'hsla(0, 0%, 0%, 0.21)',
                            ['--border-secondary' as any]: '#000000',
                            ['--border-secondary-hover' as any]: '#000000',
                            ['--border-secondary-active' as any]: 'hsla(0, 0%, 0%, 0.21)',
                            ['--color-secondary' as any]: '#111111',
                            ['--color-secondary-hover' as any]: '#111111',
                            ['--color-secondary-active' as any]: '#111111',
                          }}
                        >
                            Deselect All
                        </scale-button>
                        <div className="flex items-center space-x-2">
                            <label className="font-semibold">Filter by Severity:</label>
                            <select
                              className="w-full border p-2 rounded-md"
                              value={severityFilter}
                              onChange={handleSeverityFilterChange}

                            >
                                <option value="all">All</option>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                                <option value="critical">Critical</option>
                            </select>
                        </div>
                    </div>

                    <table className="w-full border-collapse table-fixed rounded-t-lg rounded-b-lg overflow-hidden">
                        <thead>
                        <tr>
                            <th className="px-2 py-1 bg-gray-200 w-[5%]"></th>
                            <th className="px-2 py-1 bg-gray-200 w-[20%]">ID</th>
                            <th className="px-2 py-1 bg-gray-200">Title</th>
                            <th className="px-2 py-1 bg-gray-200">Message</th>
                            <th className="px-2 py-1 bg-gray-200 w-[15%]">Option</th>
                            <th className="px-2 py-1 bg-gray-200 w-[12%]">Severity</th>
                        </tr>
                        </thead>
                        <tbody>
                        {visibleRules.map((rule, index) => (
                            <tr key={index} className="odd:bg-white even:bg-gray-100">
                                <td className="px-2 py-1 text-center">
                                    <input
                                        type="checkbox"
                                        checked={!!selectedRules.find((r) => r.id === rule.id)}
                                        onChange={() => handleRuleToggle(rule)}
                                    />
                                </td>
                                <td className={`px-2 py-1 ${styles.wordBreak}`}>{rule.id}</td>
                                <td className={`px-2 py-1 ${styles.wordBreak}`}>{rule.title}</td>
                                <td className={`px-2 py-1 ${styles.wordBreak}`}>{renderMessageCell(rule.message)}</td>
                                <td className={`px-2 py-1 ${styles.wordBreak}`}>{rule.option}</td>
                                <td className={`px-2 py-1 ${styles.wordBreak}`}>{rule.severity}</td>
                            </tr>
                        ))}
                        </tbody>
                    </table>
                </>
            )}
            {isMessageModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Rule message"
                >
                    <scale-button
                        variant="secondary"
                        className="absolute inset-0 bg-black/40"
                        onClick={closeMessageModal}
                        aria-label="Close"
                    />
                    <div className="relative z-10 w-[min(720px,95vw)] max-h-[80vh] overflow-auto rounded-lg bg-white p-4 shadow-lg">
                        <div className="flex items-start justify-between gap-4 mb-3">
                            <h3 className="text-lg font-semibold">Message</h3>
                            <scale-button
                                variant="secondary"
                                onClick={closeMessageModal}
                            >
                                Close
                            </scale-button>
                        </div>
                        <pre className="whitespace-pre-wrap break-words text-sm">{activeMessage}</pre>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RulesetsSelector;
