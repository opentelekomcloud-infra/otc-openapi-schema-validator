import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiResponse } from "next";
import handler from "@/pages/api/gitea";
import { giteaClient } from "@/clients/gitea";
import { requireApiAuth } from "@/lib/apiAuth";

jest.mock("@/clients/gitea", () => ({ giteaClient: { fetchYamlFile: jest.fn(), fetchRawYamlFile: jest.fn() } }));
jest.mock("@/lib/apiAuth", () => ({ requireApiAuth: jest.fn() }));

async function request(query: Record<string, string | string[] | undefined> = {}) {
    const req = Object.assign(new IncomingMessage(new Socket()), {
        method: "GET", headers: {}, query: { repo: "native", path: "openapi/spec.yaml", ...query },
        cookies: {}, env: {}, body: undefined,
    });
    const res = Object.assign(new ServerResponse(req), {
        status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(), redirect: jest.fn().mockReturnThis(),
        setDraftMode: jest.fn().mockReturnThis(), setPreviewData: jest.fn().mockReturnThis(),
        clearPreviewData: jest.fn().mockReturnThis(), revalidate: jest.fn(async () => undefined),
    }) satisfies NextApiResponse;
    await handler(req, res);
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(requireApiAuth).mockResolvedValue({ mode: "disabled" });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test("default callers still receive the parsed yaml envelope", async () => {
    jest.mocked(giteaClient.fetchYamlFile).mockResolvedValue({ swagger: "2.0" });
    const res = await request();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ yaml: { swagger: "2.0" } });
    expect(giteaClient.fetchRawYamlFile).not.toHaveBeenCalled();
});

test("raw mode preserves source text and requested Git ref", async () => {
    const content = "# original comment\r\nswagger: '2.0'\r\n";
    jest.mocked(giteaClient.fetchRawYamlFile).mockResolvedValue(content);
    const res = await request({ raw: "1", ref: "release/native" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ content });
    expect(giteaClient.fetchRawYamlFile).toHaveBeenCalledWith("native", "openapi/spec.yaml", "release/native");
    expect(giteaClient.fetchYamlFile).not.toHaveBeenCalled();
});

test.each([{}, { raw: "1" }])("both modes authorize before making any network request: %j", async (query) => {
    jest.mocked(requireApiAuth).mockResolvedValue(null);
    const res = await request(query);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(giteaClient.fetchYamlFile).not.toHaveBeenCalled();
    expect(giteaClient.fetchRawYamlFile).not.toHaveBeenCalled();
});

test.each([{ raw: "true" }, { repo: ["one", "two"] }, { path: "" }, { ref: ["one", "two"] }, { ref: "" }])(
    "rejects malformed source options: %j", async (query) => {
        const res = await request(query);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(giteaClient.fetchYamlFile).not.toHaveBeenCalled();
        expect(giteaClient.fetchRawYamlFile).not.toHaveBeenCalled();
    },
);

test("failed raw loading is explicit and logs only the sanitized message", async () => {
    jest.mocked(giteaClient.fetchRawYamlFile).mockRejectedValue(Object.assign(new Error("Gitea request failed"), {
        config: { secret: "TEST_PRIVATE_CONFIG" },
    }));
    const res = await request({ raw: "1" });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Gitea request failed" });
    expect(console.error).toHaveBeenCalledWith("Error while fetching YAML from Gitea:", "Gitea request failed");
});
