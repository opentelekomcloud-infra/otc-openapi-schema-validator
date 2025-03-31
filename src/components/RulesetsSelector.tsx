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
    const [hasAutoSelected, setHasAutoSelected] = useState<boolean>(false);

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

    // When a new ruleset is selected, reset selected rules and auto-selection flag.
    useEffect(() => {
        setAllRules([]);
        setSelectedRules([]);
        setHasAutoSelected(false);
    }, [selectedRuleset]);

    // When a new ruleset is selected, fetch all rules from all files of that ruleset.
    useEffect(() => {
        async function fetchAllRules() {
            const rulesArray: Rule[] = [];
            if (selectedRuleset && rulesets[selectedRuleset]) {
                const fileNames = rulesets[selectedRuleset];
                for (const file of fileNames) {
                    try {
                        const res = await fetch(`/rulesets/${selectedRuleset}/${file}.yaml`);
                        if (!res.ok) {
                            console.error(`Failed to fetch ${file}.yaml`);
                            continue;
                        }
                        const text = await res.text();
                        const data = yaml.load(text) as any;
                        if (data && data.rules && Array.isArray(data.rules)) {
                            rulesArray.push(...data.rules);
                        }
                    } catch (error) {
                        console.error("Error fetching rules for", file, error);
                    }
                }
            }
            setAllRules(rulesArray);
            // Auto-select mandatory rules only once per new ruleset.
            if (!hasAutoSelected) {
                const autoSelected = rulesArray.filter(
                    (rule) => rule.option.toLowerCase() === "mandatory"
                );
                setSelectedRules(autoSelected);
                if (onSelectionChange) {
                    onSelectionChange(autoSelected);
                }
                setHasAutoSelected(true);
            }
        }
        fetchAllRules();
    }, [selectedRuleset, rulesets, hasAutoSelected, onSelectionChange]);

    const handleRulesetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedRuleset(e.target.value);
    };

    const handleRuleToggle = (rule: Rule) => {
        let newSelected: Rule[];
        if (selectedRules.find((r) => r.id === rule.id)) {
            newSelected = selectedRules.filter((r) => r.id !== rule.id);
        } else {
            newSelected = [...selectedRules, rule];
        }
        setSelectedRules(newSelected);
        if (onSelectionChange) {
            onSelectionChange(newSelected);
        }
    };

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    const rulesetNames = Object.keys(rulesets);

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
                    {allRules.map((rule, index) => (
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
            )}
        </div>
    );
};

export default RulesetsSelector;
