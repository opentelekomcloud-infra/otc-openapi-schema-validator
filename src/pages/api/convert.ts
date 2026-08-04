import type { NextApiRequest, NextApiResponse } from "next";
import { requireApiAuth } from "@/lib/apiAuth";
import { prepareOpenApiDocument } from "@/lib/openapi/prepareOpenApiDocument";

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

  const content = req.body?.file_content;
  if (typeof content !== "string" || content.trim() === "") {
    return res.status(400).json({ error: 'Provide non-empty "file_content".' });
  }

  try {
    const prepared = await prepareOpenApiDocument(content);
    return res.status(200).json(prepared);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: message });
  }
}
