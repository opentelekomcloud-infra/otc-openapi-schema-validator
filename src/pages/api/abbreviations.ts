import path from "path";
import fs from "fs/promises";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<string[] | { error: string }>
) {
    try {
        // Build absolute path to the abbreviations file under public/lib
        const filePath = path.join(process.cwd(), "public", "lib", "allowed_abbreviations");

        const content = await fs.readFile(filePath, "utf-8");
        const abbreviations: string[] = [];

        // Primary parsing: extract quoted tokens like "id", 'api', etc.
        const regex = /["']([^"']+)["']/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            const token = match[1].trim();
            if (token) {
                abbreviations.push(token);
            }
        }

        // Fallback: if no quoted tokens were found, try comma-separated values
        if (abbreviations.length === 0) {
            content.split(",").forEach((part) => {
                const cleaned = part.trim().replace(/^["']|["']$/g, "");
                if (cleaned) {
                    abbreviations.push(cleaned);
                }
            });
        }

        res.status(200).json(abbreviations);
    } catch (error) {
        console.error("Failed to load abbreviations:", error);
        res.status(500).json({ error: "Failed to load abbreviations" });
    }
}
