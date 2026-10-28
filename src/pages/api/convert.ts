import type { NextApiRequest, NextApiResponse } from "next";
import { requireApiAuth } from "@/lib/apiAuth";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const principal = await requireApiAuth(req);
  if (!principal) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(410).json({
    error: "Automatic conversion is no longer available. Submit the original Swagger 2.0 or OpenAPI 3.0.x specification to /api/validate.",
  });
}
