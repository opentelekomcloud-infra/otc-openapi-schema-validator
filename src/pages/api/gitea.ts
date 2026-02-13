import type { NextApiRequest, NextApiResponse } from 'next';
import { giteaClient } from '@/clients/gitea';
import { requireApiAuth } from "@/lib/apiAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const expectedInternalKey = process.env.ZITADEL_X_INTERNAL_API_KEY;
    const providedInternalKey = req.headers["x-internal-api-key"];
    const isInternalCall = expectedInternalKey && providedInternalKey === expectedInternalKey;
    const principal = isInternalCall ? { mode: "internal" } : await requireApiAuth(req);
    if (!principal) return res.status(401).json({ error: "Unauthorized" });

    const { repo, path } = req.query;
    console.log("Incoming request:", { repo, path });

    if (!repo || !path) {
        console.error("Missing parameters");
        return res.status(400).json({ error: 'Missing required parameters: repo, path' });
    }

    try {
        const yaml = await giteaClient.fetchYamlFile(repo as string, path as string);
        console.log("YAML fetched successfully");
        return res.status(200).json({ yaml });
    } catch (error: any) {
        console.error("Error while fetching YAML from Gitea:", error);
        return res.status(500).json({ error: error.message });
    }
}
