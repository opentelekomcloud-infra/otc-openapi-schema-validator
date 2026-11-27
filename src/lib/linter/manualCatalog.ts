import { loadRuleCatalog } from "@/lib/linter/ruleCatalog";
import type { RulesetsStructure } from "@/utils/extract";

export type ManualRule = {
    id: string;
    title: string;
    message: string;
    option?: string;
    verified?: boolean;
};

export async function loadManualRules(): Promise<ManualRule[]> {
    const response = await fetch("/api/manuals");
    if (!response.ok) throw new Error(`Failed to fetch manual checks: HTTP ${response.status}`);
    const structure: RulesetsStructure = await response.json();
    const files = Object.values(structure).flat().map((file) => `/manual-checklist/${file}`);
    const rules = await loadRuleCatalog(files, async (file) => {
        const result = await fetch(file);
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
        return result.text();
    });
    return rules.map((rule) => ({ ...rule, verified: false }));
}
