import {promises as fs} from "fs";
import path from "path";

export type RulesetsStructure = {
    [rulesetName: string]: string[];
};

export const extractRules = async (rulesetsDir: string, result: RulesetsStructure) => {
    const folders = await fs.readdir(rulesetsDir);
    for (const folder of folders) {
        const folderPath = path.join(rulesetsDir, folder);
        const stats = await fs.stat(folderPath);
        if (stats.isDirectory()) {
            // List only YAML files in this subfolder
            const files = await fs.readdir(folderPath);
            result[folder] = files
                .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
                .map((file) => file.replace(/\.(yaml|yml)$/, ""));
        }
    }
}

export const extractManualRules = async (rulesetsDir: string, result: RulesetsStructure) => {
    const files = await fs.readdir(rulesetsDir);
    result[rulesetsDir] = files
        .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
}