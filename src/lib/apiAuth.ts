import type { NextApiRequest } from "next";
import { getToken } from "next-auth/jwt";

// NOTE:
// This API uses *opaque access tokens* for machine users.
// All bearer tokens are validated via ZITADEL token introspection (Basic Auth).

const log = {
  debug: (...args: any[]) => console.debug("[apiAuth]", ...args),
  info: (...args: any[]) => console.info("[apiAuth]", ...args),
  warn: (...args: any[]) => console.warn("[apiAuth]", ...args),
  error: (...args: any[]) => console.error("[apiAuth]", ...args),
};

const isAuthEnabled = process.env.ENABLE_AUTH === "true";

async function introspectOpaqueToken(token: string) {
  log.debug("Starting token introspection");

  const issuer = process.env.AUTH_ZITADEL_ISSUER;
  const url = issuer ? `${issuer.replace(/\/$/, "")}/oauth/v2/introspect` : undefined;

  // Prefer dedicated introspection credentials, but fall back to machine client credentials
  // (client_credentials confidential client) if you don't want extra env vars.
  const clientId =
    process.env.ZITADEL_INTROSPECTION_CLIENT_ID;
  const clientSecret =
    process.env.ZITADEL_INTROSPECTION_CLIENT_SECRET;

  log.debug("Introspection config", {
    url,
    clientId: clientId ? "set" : "missing",
    clientSecret: clientSecret ? "set" : "missing",
  });

  if (!url || !clientId || !clientSecret) {
    throw new Error(
      "Opaque access token received but introspection is not configured. Provide either ZITADEL_INTROSPECTION_CLIENT_ID and ZITADEL_INTROSPECTION_CLIENT_SECRET."
    );
  }

  const formUrlEncode = (value: string) => {
    // application/x-www-form-urlencoded encoding (spaces become +)
    return new URLSearchParams({ v: value }).toString().slice(2);
  };

  const basicAuth = Buffer.from(
    `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`
  ).toString("base64");

  const form = new URLSearchParams();
  form.set("token", token);
  form.set("token_type_hint", "access_token");
  form.set("scope", "openid");

  log.debug("Calling ZITADEL introspection endpoint");

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

  log.debug("Introspection response", {
    httpStatus: resp.status,
    body: json,
  });

  if (!resp.ok) {
    log.error("Introspection failed", json);
    const err = typeof json?.error === "string" ? json.error : "introspection_failed";
    throw new Error(`Token introspection failed: ${err}`);
  }

  return json;
}

function getBearer(req: NextApiRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [type, token] = h.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export type ApiPrincipal =
  | { mode: "disabled" }
  | { mode: "session"; token: any }
  | { mode: "bearer"; claims: any };

export async function requireApiAuth(req: NextApiRequest): Promise<ApiPrincipal | null> {
  if (!isAuthEnabled) return { mode: "disabled" };

  // Cookie/session auth (UI -> API)
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    log.error("AUTH_SECRET is not set; cannot validate session cookies");
  } else {
    const cookieNames = [
      // Auth.js v5 cookies
      "__Secure-authjs.session-token",
      "authjs.session-token",
      // Legacy NextAuth cookies
      "__Secure-next-auth.session-token",
      "next-auth.session-token",
    ];

    for (const cookieName of cookieNames) {
      const token = await getToken({
        // @ts-expect-error next-auth types may not include NextApiRequest in this version
        req,
        secret: authSecret,
        cookieName,
      }).catch((e) => {
        log.debug(`getToken failed for cookieName=${cookieName}`, e);
        return null;
      });

      if (token) {
        log.debug(`Authenticated via session cookie (${cookieName})`);
        return { mode: "session", token };
      }
    }
  }

  log.debug("No session cookie found, checking Bearer token");

  // Bearer token auth (external callers)
  const bearer = getBearer(req);
  if (bearer) {
    log.debug("Bearer token found, introspecting");
    const introspected = await introspectOpaqueToken(bearer);
    if (introspected?.active) {
      log.info("Bearer token active via introspection");
      return { mode: "bearer", claims: introspected };
    }

    log.warn("Bearer token inactive or invalid");
    return null;
  }

  log.warn("Authentication failed: no valid session or bearer token");

  return null;
}
