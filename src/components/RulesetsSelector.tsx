'use client';

import React, { useState, useEffect } from "react";

type RulesetsStructure = {
    [rulesetName: string]: string[];
};

const RulesetsSelector = () => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [selectedRuleset, setSelectedRuleset] = useState<string>("");
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);

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

    const handleRulesetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedRuleset(e.target.value);
        // Reset file selection when changing ruleset
        setSelectedFiles([]);
    };

    const handleFileToggle = (file: string) => {
        if (selectedFiles.includes(file)) {
            setSelectedFiles(selectedFiles.filter((f) => f !== file));
        } else {
            setSelectedFiles([...selectedFiles, file]);
        }
    };

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    const rulesetNames = Object.keys(rulesets);

    return (
        <div className="p-4">
            {/* Panel 1: Ruleset Dropdown */}
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

            {/* Panel 2: Files with Checkboxes */}
            {selectedRuleset && (
                <div>
                    <label className="block mb-1 font-semibold">Select Files</label>
                    <div className="border p-2">
                        {rulesets[selectedRuleset].length === 0 ? (
                            <p className="text-gray-400">No files available.</p>
                        ) : (
                            rulesets[selectedRuleset].map((file) => (
                                <div key={file} className="flex items-center mb-1">
                                    <input
                                        type="checkbox"
                                        id={`file-${file}`}
                                        checked={selectedFiles.includes(file)}
                                        onChange={() => handleFileToggle(file)}
                                    />
                                    <label htmlFor={`file-${file}`} className="ml-2">
                                        {file}
                                    </label>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default RulesetsSelector;
