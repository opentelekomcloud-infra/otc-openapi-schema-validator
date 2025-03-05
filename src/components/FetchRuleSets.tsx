'use client';

import React, { useState, useEffect } from "react";

type RulesetsStructure = {
    [rulesetName: string]: string[];
};

const RulesetsFetcher = () => {
    const [rulesetsMap, setRulesetsMap] = useState<RulesetsStructure>({});
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>("");

    useEffect(() => {
        async function fetchRulesets() {
            try {
                const res = await fetch("/api/rulesets");
                if (!res.ok) {
                    throw new Error("Failed to fetch rulesets structure");
                }
                const data: RulesetsStructure = await res.json();
                setRulesetsMap(data);
            } catch (err: any) {
                console.error(err);
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        fetchRulesets();
    }, []);

    if (loading) return <p>Loading rulesets...</p>;
    if (error) return <p>Error: {error}</p>;

    return (
        <div className="p-4 bg-gray-100 rounded shadow-md">
            <h3 className="text-xl font-bold mb-2">Fetched Rulesets Structure</h3>
            <pre className="bg-white p-2 border rounded text-sm overflow-auto">
        {JSON.stringify(rulesetsMap, null, 2)}
      </pre>
        </div>
    );
};

export default RulesetsFetcher;
