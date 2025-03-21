import path from "path";
import type {NextApiRequest, NextApiResponse} from "next";
import {extractManualRules, RulesetsStructure} from "@/utils/utils";

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<RulesetsStructure | { error: string }>
) {
    const rulesetsDir = path.join(process.cwd(), "/public/manuals");
    const result: RulesetsStructure = {};

    try {
        await extractManualRules(rulesetsDir, result);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching manual checks lists:", error);
        res.status(500).json({ error: "Failed to fetch manual checks structure" });
    }
}
