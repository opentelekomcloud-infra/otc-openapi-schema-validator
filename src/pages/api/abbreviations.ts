import type { NextApiRequest, NextApiResponse } from "next";
import { requireApiAuth } from "@/lib/apiAuth";
import { readAllowedAbbreviations } from "@/lib/server/abbreviations";

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<string[] | { error: string }>
) {
    const principal = await requireApiAuth(req);
    if (!principal) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        res.status(200).json(await readAllowedAbbreviations());
    } catch (error) {
        console.error("Failed to load abbreviations:", error);
        res.status(500).json({ error: "Failed to load abbreviations" });
    }
}
