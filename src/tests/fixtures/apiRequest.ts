import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";

export async function apiRequest(
    handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
    body: unknown = {}, method = "POST", query: NextApiRequest["query"] = {}, headers: NextApiRequest["headers"] = {},
) {
    const req = Object.assign(new IncomingMessage(new Socket()), {
        method, headers, query, cookies: {}, env: {}, body,
    }) satisfies NextApiRequest;
    const res = Object.assign(new ServerResponse(req), {
        status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(), redirect: jest.fn().mockReturnThis(),
        setDraftMode: jest.fn().mockReturnThis(), setPreviewData: jest.fn().mockReturnThis(),
        clearPreviewData: jest.fn().mockReturnThis(), revalidate: jest.fn(async () => undefined),
    }) satisfies NextApiResponse;
    await handler(req, res);
    return res;
}
