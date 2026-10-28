import type { NextApiRequest, NextApiResponse } from 'next';
import { giteaClient } from '@/clients/gitea';
import { requireApiAuth } from "@/lib/apiAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const expectedInternalKey = process.env.ZITADEL_X_INTERNAL_API_KEY;
    const providedInternalKey = req.headers["x-internal-api-key"];
    const isInternalCall = expectedInternalKey && providedInternalKey === expectedInternalKey;
    const principal = isInternalCall ? { mode: "internal" } : await requireApiAuth(req);
    if (!principal) return res.status(401).json({ error: "Unauthorized" });

    const { repo, path, raw, ref } = req.query;

    if (typeof repo !== "string" || !repo || typeof path !== "string" || !path) {
        console.error("Missing parameters");
        return res.status(400).json({ error: 'Missing required parameters: repo, path' });
    }
    if (raw !== undefined && raw !== "0" && raw !== "1") {
        return res.status(400).json({ error: 'Invalid raw parameter: expected 0 or 1' });
    }
    if (ref !== undefined && (typeof ref !== "string" || !ref)) {
        return res.status(400).json({ error: 'Invalid ref parameter: expected a non-empty string' });
    }

    try {
        if (raw === "1") {
            const content = await giteaClient.fetchRawYamlFile(repo, path, ref);
            return res.status(200).json({ content });
        }
        const yaml = await giteaClient.fetchYamlFile(repo, path, ref);
        return res.status(200).json({ yaml });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch YAML from Gitea";
        console.error("Error while fetching YAML from Gitea:", message);
        return res.status(500).json({ error: message });
    }
}
