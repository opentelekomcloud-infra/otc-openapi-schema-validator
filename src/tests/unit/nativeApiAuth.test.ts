import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { NextApiRequest } from "next";
import { apiRequest } from "@/tests/fixtures/apiRequest";

jest.mock("next-auth/jwt", () => ({ getToken: jest.fn(async () => null) }));
jest.mock("@/clients/gitea", () => ({ giteaClient: { fetchRawYamlFile: jest.fn(), fetchYamlFile: jest.fn() } }));

function request(headers: NextApiRequest["headers"] = {}): NextApiRequest {
    return Object.assign(new IncomingMessage(new Socket()), {
        headers, query: {}, cookies: {}, env: {}, body: {},
    });
}

async function loadAuth(enabled = "true") {
    process.env.ENABLE_AUTH = enabled;
    const jwt = await import("next-auth/jwt");
    const { requireApiAuth } = await import("@/lib/apiAuth");
    return { requireApiAuth, getToken: jest.mocked(jwt.getToken) };
}

beforeEach(() => {
    jest.resetModules();
    jest.replaceProperty(process, "env", {
        ...process.env, ENABLE_AUTH: "true", AUTH_SECRET: "synthetic-session-secret",
        AUTH_ZITADEL_ISSUER: "https://identity.example.invalid",
        ZITADEL_INTROSPECTION_CLIENT_ID: "synthetic-client",
        ZITADEL_INTROSPECTION_CLIENT_SECRET: "synthetic-client-secret",
        ZITADEL_X_INTERNAL_API_KEY: "synthetic-internal-key",
        NEXT_PUBLIC_APP_URL: "https://validator.example.invalid",
    });
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected authentication network access"));
    for (const method of ["debug", "info", "warn", "error"] as const) {
        jest.spyOn(console, method).mockImplementation(() => undefined);
    }
});
afterEach(() => jest.restoreAllMocks());

test("ENABLE_AUTH=false bypasses session and bearer introspection explicitly", async () => {
    const { requireApiAuth, getToken } = await loadAuth("false");
    expect(await requireApiAuth(request({ authorization: "Bearer synthetic-token" }))).toEqual({ mode: "disabled" });
    expect(getToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each([
    "__Secure-authjs.session-token", "authjs.session-token",
    "__Secure-next-auth.session-token", "next-auth.session-token",
])("valid %s session authenticates without introspection", async (cookieName) => {
    const { requireApiAuth, getToken } = await loadAuth();
    getToken.mockImplementation(async (options) => options.cookieName === cookieName ? { sub: "synthetic-user" } : null);
    expect(await requireApiAuth(request())).toEqual({ mode: "session", token: { sub: "synthetic-user" } });
    expect(getToken).toHaveBeenLastCalledWith(expect.objectContaining({ cookieName, secret: "synthetic-session-secret" }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("active opaque bearer tokens authenticate only after successful introspection", async () => {
    const { requireApiAuth } = await loadAuth();
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ active: true, sub: "synthetic-machine" })));
    expect(await requireApiAuth(request({ authorization: "Bearer synthetic-token" }))).toEqual({
        mode: "bearer", claims: { active: true, sub: "synthetic-machine" },
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://identity.example.invalid/oauth/v2/introspect", expect.objectContaining({
        method: "POST",
        body: "token=synthetic-token&token_type_hint=access_token&scope=openid",
    }));
});

test("an inactive bearer token is not accepted", async () => {
    const { requireApiAuth } = await loadAuth();
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response('{"active":false}'));
    expect(await requireApiAuth(request({ authorization: "bearer synthetic-token" }))).toBeNull();
});

test.each([{}, { authorization: "Basic synthetic" }, { authorization: "Bearer" }, {
    "x-internal-api-key": "synthetic-internal-key",
}])("missing/invalid bearer or an internal header alone does not bypass API auth: %j", async (headers) => {
    const { requireApiAuth } = await loadAuth();
    expect(await requireApiAuth(request(headers))).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("session authentication takes precedence over a supplied bearer token", async () => {
    const { requireApiAuth, getToken } = await loadAuth();
    getToken.mockResolvedValue({ sub: "synthetic-user" });
    expect(await requireApiAuth(request({ authorization: "Bearer synthetic-token" }))).toMatchObject({ mode: "session" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("introspection failures remain explicit rather than authenticating or disabling auth", async () => {
    const { requireApiAuth } = await loadAuth();
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response('{"error":"controlled-failure"}', { status: 503 }));
    await expect(requireApiAuth(request({ authorization: "Bearer synthetic-token" }))).rejects.toThrow("Token introspection failed");
});

test("missing introspection configuration does not permit a bearer token", async () => {
    delete process.env.ZITADEL_INTROSPECTION_CLIENT_SECRET;
    const { requireApiAuth } = await loadAuth();
    await expect(requireApiAuth(request({ authorization: "Bearer synthetic-token" }))).rejects.toThrow("introspection is not configured");
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("server-side Gitea baseline calls preserve caller headers and add only the configured internal header", async () => {
    const { fetchSpecFromGitea } = await import("@/utils/utils");
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response('{"yaml":{"swagger":"2.0"}}'));
    expect(await fetchSpecFromGitea({ reponame: "native", filename: "native" }, undefined, {
        authorization: "Bearer synthetic-token",
    })).toEqual({ swagger: "2.0" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://validator.example.invalid/api/gitea?repo=native&path=%2Fopenapi%2Fnative.yaml",
        { headers: { authorization: "Bearer synthetic-token", "x-internal-api-key": "synthetic-internal-key" } },
    );
});

test("browser-side Gitea baseline calls never attach the server internal key", async () => {
    const { fetchSpecFromGitea } = await import("@/utils/utils");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    jest.mocked(globalThis.fetch).mockResolvedValue(new Response('{"yaml":{"openapi":"3.0.3"}}'));
    try {
        expect(await fetchSpecFromGitea({ reponame: "native" })).toEqual({ openapi: "3.0.3" });
        expect(globalThis.fetch).toHaveBeenCalledWith(
            "/api/gitea?repo=native&path=%2Fopenapi%2Fnative.yaml", { headers: undefined },
        );
    } finally {
        Reflect.deleteProperty(globalThis, "window");
    }
});

test("only the Gitea endpoint explicitly accepts its matching server-to-server internal key", async () => {
    const { getToken } = await loadAuth();
    const { default: gitea } = await import("@/pages/api/gitea");
    const { giteaClient } = await import("@/clients/gitea");
    jest.mocked(giteaClient.fetchRawYamlFile).mockResolvedValue("swagger: '2.0'\r\n");
    const res = await apiRequest(gitea, {}, "GET", { repo: "native", path: "openapi/native.yaml", raw: "1" }, {
        "x-internal-api-key": "synthetic-internal-key",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ content: "swagger: '2.0'\r\n" });
    expect(giteaClient.fetchRawYamlFile).toHaveBeenCalledWith("native", "openapi/native.yaml", undefined);
    expect(getToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each([undefined, "wrong-synthetic-key", ["synthetic-internal-key", "another-key"]])(
    "Gitea rejects a missing, incorrect or ambiguous internal key without other auth: %j", async (key) => {
        await loadAuth();
        const { default: gitea } = await import("@/pages/api/gitea");
        const { giteaClient } = await import("@/clients/gitea");
        const res = await apiRequest(gitea, {}, "GET", { repo: "native", path: "openapi/native.yaml", raw: "1" }, {
            "x-internal-api-key": key,
        });
        expect(res.status).toHaveBeenCalledWith(401);
        expect(giteaClient.fetchRawYamlFile).not.toHaveBeenCalled();
        expect(giteaClient.fetchYamlFile).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    },
);
