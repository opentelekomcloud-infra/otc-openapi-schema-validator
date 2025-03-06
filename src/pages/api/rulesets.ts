import { promises as fs } from "fs";
import path from "path";
import type { NextApiRequest, NextApiResponse } from "next";

type RulesetsStructure = {
    [rulesetName: string]: string[];
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<RulesetsStructure | { error: string }>
) {
    const rulesetsDir = path.join(process.cwd(), "/public/rulesets");
    const result: RulesetsStructure = {};

    try {
        // List all items in the rulesets folder
        const folders = await fs.readdir(rulesetsDir);
        for (const folder of folders) {
            const folderPath = path.join(rulesetsDir, folder);
            const stats = await fs.stat(folderPath);
            if (stats.isDirectory()) {
                // List only YAML files in this subfolder
                const files = await fs.readdir(folderPath);
                const yamlFiles = files
                    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
                    .map((file) => file.replace(/\.(yaml|yml)$/, ""));
                result[folder] = yamlFiles;
            }
        }
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching rulesets:", error);
        res.status(500).json({ error: "Failed to fetch rulesets structure" });
    }
}
