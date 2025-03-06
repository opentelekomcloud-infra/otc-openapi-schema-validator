'use client';

import React, { useState, useEffect } from "react";
import yaml from "js-yaml";

type RulesetsStructure = {
    [rulesetName: string]: string[];
};

type Rule = {
    id: string;
    title: string;
    [key: string]: any;
};


type RulesetsSelectorProps = {
    onSelectionChange?: (selectedFileRules: Record<string, Rule[]>) => void;
};

const RulesetsSelector = ({ onSelectionChange }: RulesetsSelectorProps) => {
    // Overall rulesets structure fetched from API.
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");

    // Panel 1: Selected ruleset
    const [selectedRuleset, setSelectedRuleset] = useState<string>("");

    // Panel 2: Selected files from the ruleset
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);

    // Panel 3: Map of file -> array of rules (fetched and parsed)
    const [fileRulesMap, setFileRulesMap] = useState<Record<string, Rule[]>>({});

    // Panel 3: Selected rules from each file (now storing full rule objects)
    const [selectedFileRules, setSelectedFileRules] = useState<Record<string, Rule[]>>({});

    // Fetch the rulesets structure
    useEffect(() => {
        async function fetchRulesets() {
            try {
                const res = await fetch("/api/rulesets");
                if (!res.ok) {
                    throw new Error("Failed to fetch rulesets");
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

    // Clear downstream selections when ruleset changes
    useEffect(() => {
        setSelectedFiles([]);
        setFileRulesMap({});
        setSelectedFileRules({});
    }, [selectedRuleset]);

    // Effect to notify parent about selectedFileRules changes
    useEffect(() => {
        if (onSelectionChange) {
            onSelectionChange(selectedFileRules);
        }
    }, [selectedFileRules, onSelectionChange]);

    // Fetch YAML rules for a selected file if not already fetched
    useEffect(() => {
        async function fetchFileRules(file: string) {
            try {
                const res = await fetch(`/rulesets/${selectedRuleset}/${file}.yaml`);
                if (!res.ok) {
                    console.error(`Failed to fetch ${file}.yaml`);
                    return;
                }
                const text = await res.text();
                const data = yaml.load(text) as any;
                if (data && data.rules && Array.isArray(data.rules)) {
                    // Store the full rule objects
                    const rules: Rule[] = data.rules.map((rule: any) => rule);
                    setFileRulesMap(prev => ({ ...prev, [file]: rules }));
                }
            } catch (error) {
                console.error("Error fetching rules for", file, error);
            }
        }

        selectedFiles.forEach(file => {
            if (!fileRulesMap[file]) {
                fetchFileRules(file);
            }
        });

        // Remove stale entries if files are no longer selected
        setFileRulesMap(prev => {
            const newMap: Record<string, Rule[]> = {};
            selectedFiles.forEach(file => {
                if (prev[file]) {
                    newMap[file] = prev[file];
                }
            });
            return newMap;
        });

        // Clean up selected rules for files no longer selected
        setSelectedFileRules(prev => {
            const newSelected: Record<string, Rule[]> = {};
            selectedFiles.forEach(file => {
                if (prev[file]) {
                    newSelected[file] = prev[file];
                }
            });
            return newSelected;
        });
    }, [selectedFiles, selectedRuleset]);

    // Handlers for UI events
    const handleRulesetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedRuleset(e.target.value);
    };

    const handleFileToggle = (file: string) => {
        if (selectedFiles.includes(file)) {
            setSelectedFiles(selectedFiles.filter(f => f !== file));
        } else {
            setSelectedFiles([...selectedFiles, file]);
        }
    };

    // Now toggling the rule will add/remove the full rule object.
    const handleRuleToggle = (file: string, rule: Rule) => {
        setSelectedFileRules(prev => {
            const current = prev[file] || [];
            if (current.find(r => r.id === rule.id)) {
                return { ...prev, [file]: current.filter(r => r.id !== rule.id) };
            } else {
                return { ...prev, [file]: [...current, rule] };
            }
        });
    };

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    const rulesetNames = Object.keys(rulesets);

    return (
        <div className="p-4">
            <div className="grid grid-cols-3 gap-4">
                {/* Panel 1: Ruleset Dropdown */}
                <div>
                    <label className="block mb-1 font-semibold">Select Ruleset</label>
                    <select
                        value={selectedRuleset}
                        onChange={handleRulesetChange}
                        className="border p-2 w-full"
                    >
                        <option value="">-- Select a ruleset --</option>
                        {rulesetNames.map(ruleset => (
                            <option key={ruleset} value={ruleset}>
                                {ruleset}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Panel 2: Files Checkboxes */}
                <div>
                    {selectedRuleset && (
                        <>
                            <label className="block mb-1 font-semibold">Select Files</label>
                            <div className="border p-2">
                                {rulesets[selectedRuleset]?.length === 0 ? (
                                    <p className="text-gray-400">No files available.</p>
                                ) : (
                                    rulesets[selectedRuleset].map(file => (
                                        <div key={file} className="flex items-center mb-1">
                                            <input
                                                type="checkbox"
                                                id={`file-${file}`}
                                                checked={selectedFiles.includes(file)}
                                                onChange={() => handleFileToggle(file)}
                                                className={"break-words"}
                                            />
                                            <label
                                                htmlFor={`file-${file}`}
                                                className="ml-2 block whitespace-normal break-all"
                                            >
                                                {file}
                                            </label>
                                        </div>
                                    ))
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Panel 3: Rules Checkboxes */}
                <div>
                    {selectedFiles.length > 0 && (
                        <>
                            <label className="block mb-1 font-semibold">Select Rules</label>
                            <div className="border p-2 overflow-auto max-h-96">
                                {selectedFiles.map(file => (
                                    <div key={file} className="mb-4 block whitespace-normal break-all">
                                        <h4 className="font-semibold mb-1">{file}</h4>
                                        {fileRulesMap[file] ? (
                                            fileRulesMap[file].map(rule => (
                                                <div key={rule.id} className="flex items-center mb-1">
                                                    <input
                                                        type="checkbox"
                                                        id={`rule-${file}-${rule.id}`}
                                                        checked={
                                                            (selectedFileRules[file] || []).some(
                                                                r => r.id === rule.id
                                                            )
                                                        }
                                                        onChange={() => handleRuleToggle(file, rule)}
                                                    />
                                                    <label
                                                        htmlFor={`rule-${file}-${rule.id}`}
                                                        className="ml-2 block whitespace-normal break-all"
                                                    >
                                                        {rule.id} {rule.title}
                                                    </label>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-gray-400">Loading rules...</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RulesetsSelector;
