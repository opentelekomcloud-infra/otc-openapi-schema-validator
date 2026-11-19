import type { NextApiRequest, NextApiResponse } from "next";
import { requireApiAuth } from "@/lib/apiAuth";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
    }
    if (!await requireApiAuth(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
        const { giteaClient } = await import("@/clients/gitea");
        await giteaClient.checkAvailability();
        return res.status(200).json({ available: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Gitea availability check failed";
        console.error("Gitea availability check failed:", message);
        return res.status(503).json({ available: false, error: "Could not connect to Gitea." });
    }
}
