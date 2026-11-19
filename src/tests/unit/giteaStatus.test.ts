import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiResponse } from "next";
import handler from "@/pages/api/gitea-status";
import { giteaClient } from "@/clients/gitea";
import { requireApiAuth } from "@/lib/apiAuth";

jest.mock("@/clients/gitea", () => ({ giteaClient: { checkAvailability: jest.fn() } }));
jest.mock("@/lib/apiAuth", () => ({ requireApiAuth: jest.fn() }));

async function request(method = "GET") {
    const req = Object.assign(new IncomingMessage(new Socket()), {
        method, headers: {}, query: {}, cookies: {}, env: {}, body: undefined,
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
    jest.mocked(giteaClient.checkAvailability).mockResolvedValue(undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test("successful availability checks return an uncached status without upstream details", async () => {
    const res = await request();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ available: true });
    expect(res.getHeader("Cache-Control")).toBe("no-store");
    expect(giteaClient.checkAvailability).toHaveBeenCalledTimes(1);
});

test("unavailable Gitea is explicit and logged, not reported as healthy", async () => {
    jest.mocked(giteaClient.checkAvailability).mockRejectedValue(new Error("Gitea availability check failed: HTTP 500"));
    const res = await request();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ available: false, error: "Could not connect to Gitea." });
    expect(console.error).toHaveBeenCalledWith("Gitea availability check failed:", "Gitea availability check failed: HTTP 500");
});

test("unexpected runtime errors are logged without exposing internals in the response", async () => {
    const message = "__TURBOPACK__imported__module__.giteaClient.checkAvailability is not a function";
    jest.mocked(giteaClient.checkAvailability).mockRejectedValue(new TypeError(message));
    const res = await request();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ available: false, error: "Could not connect to Gitea." });
    expect(console.error).toHaveBeenCalledWith("Gitea availability check failed:", message);
});

test("unauthenticated requests cannot trigger the probe", async () => {
    jest.mocked(requireApiAuth).mockResolvedValue(null);
    expect((await request()).status).toHaveBeenCalledWith(401);
    expect(giteaClient.checkAvailability).not.toHaveBeenCalled();
});

test("unsupported methods cannot trigger the probe", async () => {
    const res = await request("POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.getHeader("Allow")).toBe("GET");
    expect(giteaClient.checkAvailability).not.toHaveBeenCalled();
});
