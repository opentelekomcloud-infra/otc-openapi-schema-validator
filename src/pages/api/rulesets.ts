import path from "path";
import type {NextApiRequest, NextApiResponse} from "next";
import {extractRules, RulesetsStructure} from "@/utils/utils";

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<RulesetsStructure | { error: string }>
) {
    const rulesetsDir = path.join(process.cwd(), "/public/rulesets");
    const result: RulesetsStructure = {};

    try {
        // List all items in the rulesets folder
        await extractRules(rulesetsDir, result);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching rulesets:", error);
        res.status(500).json({ error: "Failed to fetch rulesets structure" });
    }
}
