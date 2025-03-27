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

export async function fetchManualRulesFromAPI(): Promise<ManualRule[]> {
    const allManualRules: ManualRule[] = [];
    try {
        const resManuals = await fetch("/api/manuals");
        if (!resManuals.ok) {
            console.error("Failed to fetch manual rules structure");
            return allManualRules;
        }
        const rulesets: RulesetsStructure = await resManuals.json();
        for (const folder in rulesets) {
            for (const fileName of rulesets[folder]) {
                try {
                    const res = await fetch(`/manuals/${fileName}`);
                    if (!res.ok) {
                        console.error(`Failed to fetch manual rule file ${fileName}`);
                        continue;
                    }
                    const text = await res.text();
                    const data = yaml.load(text) as any;
                    if (data && data.rules && Array.isArray(data.rules)) {
                        // Extend each rule with verified default (false)
                        const newRules = data.rules.map((rule: any) => ({
                            ...rule,
                            verified: false,
                        }));
                        allManualRules.push(...newRules);
                    }
                } catch (err) {
                    console.error("Error fetching manual rule file", err);
                }
            }
        }
    } catch (err) {
        console.error("Error fetching manual rules structure:", err);
    }
    return allManualRules;
}

const ManualChecksSelector: React.FC<ManualChecksSelectorProps> = ({
                                                                       onManualRulesChange,
                                                                   }) => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [manualRules, setManualRules] = useState<ManualRule[]>([]);

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

    // When rulesets are loaded, fetch all manual rules.
    useEffect(() => {
        async function fetchManualRules() {
            const allRules: ManualRule[] = [];
            for (const folder in rulesets) {
                for (const fileName of rulesets[folder]) {
                    try {
                        const res = await fetch(`/manuals/${fileName}`);
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
            // If there are no stored rules yet, update state with fetched ones.
            if (allRules.length > 0 && manualRules.length === 0) {
                setManualRules(allRules);
            }
        }
        if (Object.keys(rulesets).length > 0) {
            fetchManualRules();
        }
    }, [rulesets]);

    // Toggle verified state for a rule.
    const handleRuleToggle = (ruleId: string) => {
        const updatedRules = manualRules.map((rule) =>
            rule.id === ruleId ? { ...rule, verified: !rule.verified } : rule
        );
        setManualRules(updatedRules);
        console.log("Updated manual rules:", updatedRules);
    };

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    return (
        <table className="w-full border-collapse">
            <thead>
            <tr>
                <th className="border px-2 py-1"></th>
                <th className={`border px-2 py-1 ${styles.wordBreak} w-1/9`}>ID</th>
                <th className={`border px-2 py-1 ${styles.wordBreak} w-1/9`}>Title</th>
                <th className={`border px-2 py-1 ${styles.wordBreak} w-6/9`}>Message</th>
                <th className={`border px-2 py-1 ${styles.wordBreak} w-1/9`}>Option</th>
            </tr>
            </thead>
            <tbody>
            {manualRules.map((rule) => {
                // Set row color based on verified state
                const rowClass = rule.verified ? "bg-green-200" : "odd:bg-blue-200 even:bg-blue-100";
                return (
                    <tr key={rule.id} className={`border ${rowClass}`}>
                        <td className="border px-2 py-1 text-center">
                            <input
                                type="checkbox"
                                checked={!!rule.verified}
                                onChange={() => handleRuleToggle(rule.id)}
                            />
                        </td>
                        <td className="border px-2 py-1">{rule.id}</td>
                        <td className="border px-2 py-1">{rule.title}</td>
                        <td className="border px-2 py-1 whitespace-normal break-all">
                            <ReactMarkdown>{rule.message}</ReactMarkdown>
                        </td>
                        <td className="border px-2 py-1">{rule.option}</td>
                    </tr>
                );
            })}
            </tbody>
        </table>
    );
};

export default ManualChecksSelector;
