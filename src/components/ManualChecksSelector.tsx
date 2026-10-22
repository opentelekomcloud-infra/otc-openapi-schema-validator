'use client';

import React, { useState, useEffect } from "react";
import type { RulesetsStructure } from "@/utils/extract";
import { loadRuleCatalog } from "@/lib/linter/ruleCatalog";
import ReactMarkdown from "react-markdown";
import styles from "@/components/Table.module.css";

export type ManualRule = {
    id: string;
    title: string;
    message: string;
    option?: string;
    verified?: boolean;
};

type ManualChecksSelectorProps = {
    onManualRulesChange?: (manualRules: ManualRule[]) => void;
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

const ManualChecksSelector: React.FC<ManualChecksSelectorProps> = ({
                                                                       onManualRulesChange,
                                                                   }) => {
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
                        className="underline text-gray-600 hover:text-gray-800"
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

    // Load immediately after restoring verification state, then refresh every 30 seconds.
    useEffect(() => {
        if (!initialized) return;
        let cancelled = false;
        let refreshing = false;
        async function refresh() {
            if (refreshing) return;
            refreshing = true;
            try {
                const resRulesets = await fetch("/api/manuals");
                if (!resRulesets.ok) {
                    throw new Error(`Failed to fetch manual checks: HTTP ${resRulesets.status}`);
                }
                const updatedRulesets: RulesetsStructure = await resRulesets.json();
                const fetchedRules = await fetchAllManualRules(updatedRulesets);
                if (cancelled) return;
                setError("");
                setManualRules((prevRules) => {
                    const mergedRules = fetchedRules.map((newRule) => {
                        const existingRule = prevRules.find((r) => r.id === newRule.id);
                        return existingRule ? { ...newRule, verified: existingRule.verified } : newRule;
                    });
                    if (JSON.stringify(prevRules) !== JSON.stringify(mergedRules)) {
                        return mergedRules;
                    }
                    return prevRules;
                });
            } catch (err: unknown) {
                if (cancelled) return;
                console.error("Failed to load manual checks", err);
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                refreshing = false;
                if (!cancelled) setLoading(false);
            }
        }
        refresh();
        const intervalId = setInterval(refresh, 30000);
        return () => {
            cancelled = true;
            clearInterval(intervalId);
        };
    }, [initialized]);

    // Toggle verified state for a rule.
    const handleRuleToggle = (ruleId: string) => {
        const updatedRules = manualRules.map((rule) =>
            rule.id === ruleId ? { ...rule, verified: !rule.verified } : rule
        );
        setManualRules(updatedRules);
    };

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p role="alert">Error: {error}</p>;

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
