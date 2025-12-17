import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Obtains an access token using OAuth 2.0 Client Credentials (machine account).
 * POST /api/token/machine
 * Uses HTTP Basic Auth (client_id:client_secret)
 * Returns: access_token, token_type, expires_in, scope
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expectedApiKey = process.env.ZITADEL_X_INTERNAL_API_KEY;
  if (!expectedApiKey) {
    console.error("[token/machine] ZITADEL_X_INTERNAL_API_KEY is not set");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const providedApiKey = req.headers["x-internal-api-key"];
  if (providedApiKey !== expectedApiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const issuer = process.env.AUTH_ZITADEL_ISSUER;
  const clientId = process.env.ZITADEL_MACHINE_ID;
  const clientSecret = process.env.ZITADEL_MACHINE_SECRET;
  const projectId = process.env.ZITADEL_PROJECT_ID;
  if (!projectId) {
    console.warn(
      "[token/machine] ZITADEL_PROJECT_ID is not set. Tokens may not be introspectable (active:false)."
    );
  }

  if (!issuer || !clientId || !clientSecret) {
    return res.status(500).json({
      error:
        "Missing AUTH_ZITADEL_ISSUER, ZITADEL_MACHINE_ID or ZITADEL_MACHINE_SECRET in environment.",
    });
  }

  try {
    const url = `${issuer.replace(/\/$/, "")}/oauth/v2/token`;

    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");

    // Add the project audience scope so the project id is included in the token audience.
    // This is required for ZITADEL introspection to return active:true for some setups.
    const baseScope = "openid profile email";
    const audienceScope = projectId
      ? `urn:zitadel:iam:org:project:id:${projectId}:aud`
      : "";
    const scope = [baseScope, audienceScope].filter(Boolean).join(" ");
    form.set("scope", scope);

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: form.toString(),
    });

    const text = await resp.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!resp.ok) {
      return res.status(resp.status).json(json);
    }

    return res.status(200).json(json);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
