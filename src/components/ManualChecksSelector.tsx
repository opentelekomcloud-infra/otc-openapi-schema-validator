'use client';

import React, { useState, useEffect } from "react";
import yaml from "js-yaml";
import { RulesetsStructure } from "@/utils/extract";
import ReactMarkdown from "react-markdown";
import styles from "@/components/Table.module.css";

export type ManualRule = {
    id: string;
    title: string;
    message: string;
    option: string;
    verified?: boolean;
};

type ManualChecksSelectorProps = {
    onManualRulesChange?: (manualRules: ManualRule[]) => void;
};

const ManualChecksSelector: React.FC<ManualChecksSelectorProps> = ({
                                                                       onManualRulesChange,
                                                                   }) => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [manualRules, setManualRules] = useState<ManualRule[]>([]);
    const [initialized, setInitialized] = useState<boolean>(false);

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
            <div>
                <ReactMarkdown>{preview}</ReactMarkdown>
                {needsTruncate && (
                    <button
                        type="button"
                        onClick={() => openMessageModal(safe)}
                        className="underline text-blue-600 hover:text-blue-800"
                    >
                        ..show more
                    </button>
                )}
            </div>
        );
    };

    // On mount, load stored manual rules from localStorage (if any)
    useEffect(() => {
        const storedRules = localStorage.getItem("manualRules");
        if (storedRules) {
            try {
                setManualRules(JSON.parse(storedRules));
            } catch (err) {
                console.error("Error parsing stored manual rules:", err);
            }
        }
        setInitialized(true);
    }, []);

    // Save manualRules to localStorage whenever they change.
    useEffect(() => {
        localStorage.setItem("manualRules", JSON.stringify(manualRules));
        if (onManualRulesChange) {
            onManualRulesChange(manualRules);
        }
    }, [manualRules, onManualRulesChange]);

    // Fetch rulesets structure.
    useEffect(() => {
        async function fetchRulesets() {
            try {
                const res = await fetch("/api/manuals");
                if (!res.ok) {
                    console.error("Failed to fetch rules for manual checks");
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

    // Function to fetch all manual rules (from all files).
    async function fetchAllManualRules() {
        const allRules: ManualRule[] = [];
        for (const folder in rulesets) {
            for (const fileName of rulesets[folder]) {
                try {
                    const res = await fetch(`/manual-checklist/${fileName}`);
                    if (!res.ok) {
                        console.error(`Failed to fetch manual rule file ${fileName}`);
                        continue;
                    }
                    const text = await res.text();
                    const data = yaml.load(text) as any;
                    if (data && data.rules && Array.isArray(data.rules)) {
                        const newRules = data.rules.map((rule: any) => ({
                            ...rule,
                            verified: false,
                        }));
                        allRules.push(...newRules);
                    }
                } catch (err) {
                    console.error("Error fetching manual rule file", err);
                }
            }
        }
        return allRules;
    }

    // Polling: Re-fetch manual rules every 30 seconds after initial localStorage load.
    useEffect(() => {
        if (!initialized) return;
        const intervalId = setInterval(async () => {
            try {
                // First, update the rulesets.
                const resRulesets = await fetch("/api/manuals");
                if (!resRulesets.ok) {
                    console.error("Failed to fetch rules for manual checks");
                    return;
                }
                const updatedRulesets: RulesetsStructure = await resRulesets.json();
                setRulesets(updatedRulesets);

                if (Object.keys(updatedRulesets).length > 0) {
                    // Then, fetch all manual rules using the updated rulesets.
                    const fetchedRules = await fetchAllManualRules();
                    setManualRules((prevRules) => {
                        // Merge new rules with previous ones preserving the verified state.
                        const mergedRules = fetchedRules.map((newRule) => {
                            const existingRule = prevRules.find((r) => r.id === newRule.id);
                            return existingRule ? { ...newRule, verified: existingRule.verified } : newRule;
                        });
                        // Only update if there are changes.
                        if (JSON.stringify(prevRules) !== JSON.stringify(mergedRules)) {
                            if (onManualRulesChange) {
                                onManualRulesChange(mergedRules);
                            }
                            return mergedRules;
                        }
                        return prevRules;
                    });
                }
            } catch (err: any) {
                console.error("Polling error:", err.message);
            }
        }, 30000);
        return () => clearInterval(intervalId);
    }, [initialized, onManualRulesChange, rulesets]);

    // Toggle verified state for a rule.
    const handleRuleToggle = (ruleId: string) => {
        const updatedRules = manualRules.map((rule) =>
            rule.id === ruleId ? { ...rule, verified: !rule.verified } : rule
        );
        setManualRules(updatedRules);
    };

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    return (
        <div>
            <div className="flex items-center space-x-4 mb-2">
                <scale-button
                  onClick={() => {
                      const updated = manualRules.map(rule => ({...rule, verified: true}));
                      setManualRules(updated);
                  }}
                  variant="primary"
                  size="m"
                >
                    Select All
                </scale-button>
                <scale-button
                  onClick={() => {
                      const updated = manualRules.map(rule => ({...rule, verified: false}));
                      setManualRules(updated);
                  }}
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
            </div>
            <table className="w-full border-collapse table-fixed rounded-t-lg rounded-b-lg overflow-hidden">
                <thead>
                <tr>
                    <th className="px-2 py-1 bg-gray-200 w-[5%]"></th>
                    <th className={`px-2 py-1 ${styles.wordBreak} bg-gray-200 w-[20%]`}>ID</th>
                    <th className={`px-2 py-1 ${styles.wordBreak} bg-gray-200`}>Title</th>
                    <th className={`px-2 py-1 ${styles.wordBreak} bg-gray-200 w-[40%]`}>Message</th>
                <th className={`px-2 py-1 ${styles.wordBreak} bg-gray-200 w-[15%]`}>Option</th>
            </tr>
            </thead>
            <tbody>
            {manualRules.map((rule) => {
                // Set row color based on verified state
                const rowClass = rule.verified
                    ? "bg-green-50"
                    : "odd:bg-white even:bg-gray-100";
                return (
                    <tr key={rule.id} className={`${rowClass}`}>
                        <td className="px-2 py-1 text-center">
                            <input
                                type="checkbox"
                                checked={!!rule.verified}
                                onChange={() => handleRuleToggle(rule.id)}
                            />
                        </td>
                        <td className="px-2 py-1">{rule.id}</td>
                        <td className="px-2 py-1">{rule.title}</td>
                        <td className="px-2 py-1 whitespace-normal break-all">
                            {renderMessageCell(rule.message)}
                        </td>
                        <td className="px-2 py-1">{rule.option}</td>
                    </tr>
                );
            })}
            </tbody>
            </table>
            {isMessageModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Manual check message"
                >
                    <button
                        type="button"
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
                        <div className="text-sm">
                            <ReactMarkdown>{activeMessage}</ReactMarkdown>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ManualChecksSelector;
