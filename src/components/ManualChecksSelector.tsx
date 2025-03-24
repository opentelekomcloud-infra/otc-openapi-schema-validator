'use client';

import React, { useState, useEffect } from "react";
import yaml from "js-yaml";
import { RulesetsStructure } from "@/utils/extract";
import ReactMarkdown from "react-markdown";

export type ManualRule = {
    id: string;
    title: string;
    message: string;
    option: string;
    severity: string;
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
                    const fileRes = await fetch(`/manuals/${fileName}`);
                    if (!fileRes.ok) {
                        console.error(`Failed to fetch file: /manuals/${fileName}`);
                        continue;
                    }
                    const text = await fileRes.text();
                    const data = yaml.load(text) as any;
                    if (data && data.rules && Array.isArray(data.rules)) {
                        allManualRules.push(...data.rules);
                    }
                } catch (e) {
                    console.error("Error fetching/parsing manual rule file:", e);
                }
            }
        }
    } catch (e) {
        console.error("Error fetching manual rules structure:", e);
    }
    return allManualRules;
}


const ManualChecksSelector: React.FC<ManualChecksSelectorProps> = ({ onManualRulesChange }) => {
    const [rulesets, setRulesets] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");
    const [manualRules, setManualRules] = useState<ManualRule[]>([]);

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
                            allRules.push(...data.rules);
                        }
                    } catch (err) {
                        console.error("Error fetching manual rule file", err);
                    }
                }
            }
            setManualRules(allRules);
            if (onManualRulesChange) {
                onManualRulesChange(allRules);
            }
        }

        if (Object.keys(rulesets).length > 0) {
            fetchManualRules();
        }
    }, [rulesets, onManualRulesChange]);

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    return (
        <table className="w-full border-collapse">
            <thead>
            <tr>
                <th className="border px-2 py-1 w-1/8">ID</th>
                <th className="border px-2 py-1 w-1/8">Title</th>
                <th className="border px-2 py-1 w-5/8">Summary</th>
                <th className="border px-2 py-1 w-1/8">Option</th>
            </tr>
            </thead>
            <tbody>
            {manualRules.map((rule, index) => (
                <tr key={index} className="odd:bg-blue-200 even:bg-blue-100">
                    <td className="border px-2 py-1">{rule.id}</td>
                    <td className="border px-2 py-1">{rule.title}</td>
                    <td className="border px-2 py-1">
                        <ReactMarkdown>{rule.message}</ReactMarkdown>
                    </td>
                    <td className="border px-2 py-1">{rule.option}</td>
                </tr>
            ))}
            </tbody>
        </table>
    );
};

export default ManualChecksSelector;
