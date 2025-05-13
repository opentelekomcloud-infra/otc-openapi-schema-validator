'use client';

import React, { useState, useEffect } from "react";
import yaml from "js-yaml";
import { RulesetsStructure } from "@/utils/extract";
import styles from "@/components/Table.module.css";

export type Rule = {
    id: string;
    title: string;
    message: string;
    option: string;
    location: string;
    element: string;
    then: {
        function: string;
        functionParams?: any;
    };
    severity: string;
};

type RulesetsSelectorProps = {
    onSelectionChange?: (selectedRules: Rule[]) => void;
};

const RulesetsSelector = ({ onSelectionChange }: RulesetsSelectorProps) => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");

    const [selectedRuleset, setSelectedRuleset] = useState<string>("");
    const [allRules, setAllRules] = useState<Rule[]>([]);
    const [selectedRules, setSelectedRules] = useState<Rule[]>([]);
    const [severityFilter, setSeverityFilter] = useState<string>("all");

    useEffect(() => {
        async function fetchRulesets() {
            try {
                const res = await fetch("/api/rulesets");
                if (!res.ok) {
                    console.error("Failed to fetch rulesets");
                }
                const data: RulesetsStructure = await res.json();
                setRulesets(data);
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        fetchRulesets();
    }, []);

    useEffect(() => {
        async function fetchAllRules() {
            const rulesArray: Rule[] = [];
            if (selectedRuleset && rulesets[selectedRuleset]) {
                const fileNames = rulesets[selectedRuleset];
                for (const file of fileNames) {
                    try {
                        const res = await fetch(`/rulesets/${selectedRuleset}/${file}.yaml`);
                        if (!res.ok) continue;
                        const text = await res.text();
                        const data = yaml.load(text) as any;
                        if (data?.rules && Array.isArray(data.rules)) {
                            rulesArray.push(...data.rules);
                        }
                    } catch (error) {
                        console.error("Error fetching rules for", file, error);
                    }
                }
            }

            setAllRules(rulesArray);
            const mandatoryRules = rulesArray.filter(
                (rule) => rule.option.toLowerCase() === "mandatory"
            );
            setSelectedRules(mandatoryRules);
            if (onSelectionChange) {
                onSelectionChange(mandatoryRules);
            }
        }

        if (selectedRuleset) {
            fetchAllRules();
        } else {
            setAllRules([]);
            setSelectedRules([]);
        }
    }, [selectedRuleset, rulesets]);

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
    if (error) return <p>Error: {error}</p>;

    const rulesetNames = Object.keys(rulesets);
    const visibleRules = applySeverityFilter(allRules);

    return (
        <div>
            <div className="mb-4">
                <label className="block mb-1 font-semibold">Select Ruleset</label>
                <select
                    value={selectedRuleset}
                    onChange={handleRulesetChange}
                    className="border p-2 w-full"
                >
                    <option value="">-- Select a ruleset --</option>
                    {rulesetNames.map((ruleset) => (
                        <option key={ruleset} value={ruleset}>
                            {ruleset}
                        </option>
                    ))}
                </select>
            </div>
            {selectedRuleset && (
                <>
                    <div className="flex items-center space-x-4 mb-2">
                        <button
                            onClick={handleSelectAll}
                            className="px-2 py-1 bg-gray-300 rounded hover:bg-gray-400 transition"
                        >
                            Select All
                        </button>
                        <button
                            onClick={handleDeselectAll}
                            className="px-2 py-1 bg-gray-300 rounded hover:bg-gray-400 transition"
                        >
                            Deselect All
                        </button>
                        <div className="flex items-center space-x-2">
                            <label className="font-semibold">Filter by Severity:</label>
                            <select
                                className="border p-1"
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

                    <table className="w-full border-collapse">
                        <thead>
                        <tr>
                            <th className="border px-2 py-1"></th>
                            <th className="border px-2 py-1">ID</th>
                            <th className="border px-2 py-1">Title</th>
                            <th className="border px-2 py-1">Message</th>
                            <th className="border px-2 py-1">Option</th>
                            <th className="border px-2 py-1">Severity</th>
                        </tr>
                        </thead>
                        <tbody>
                        {visibleRules.map((rule, index) => (
                            <tr key={index} className="odd:bg-gray-200 even:bg-gray-100">
                                <td className="border px-2 py-1 text-center">
                                    <input
                                        type="checkbox"
                                        checked={!!selectedRules.find((r) => r.id === rule.id)}
                                        onChange={() => handleRuleToggle(rule)}
                                    />
                                </td>
                                <td className={`border px-2 py-1 ${styles.wordBreak}`}>{rule.id}</td>
                                <td className={`border px-2 py-1 ${styles.wordBreak}`}>{rule.title}</td>
                                <td className={`border px-2 py-1 ${styles.wordBreak}`}>{rule.message}</td>
                                <td className={`border px-2 py-1 ${styles.wordBreak}`}>{rule.option}</td>
                                <td className={`border px-2 py-1 ${styles.wordBreak}`}>{rule.severity}</td>
                            </tr>
                        ))}
                        </tbody>
                    </table>
                </>
            )}
        </div>
    );
};

export default RulesetsSelector;
