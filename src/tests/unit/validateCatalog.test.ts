import fs from "node:fs/promises";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiResponse } from "next";
import handler from "@/pages/api/validate";
import { runLinter } from "@/lib/linter/runLinter";

jest.mock("node:fs/promises", () => {
    const actual = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    return { ...actual, readFile: jest.fn(actual.readFile) };
});
jest.mock("@/lib/apiAuth", () => ({
    requireApiAuth: jest.fn(async () => ({ mode: "disabled" })),
}));
jest.mock("@/clients/gitea", () => ({
    giteaClient: { fetchYamlFile: jest.fn() },
}));
jest.mock("@/clients/reportportal", () => ({
    reportPortalClient: { importLaunch: jest.fn() },
}));
jest.mock("@/lib/linter/runLinter", () => ({
    ...jest.requireActual<typeof import("@/lib/linter/runLinter")>("@/lib/linter/runLinter"),
    runLinter: jest.fn(async () => ({ diagnostics: [], specTitle: "Demo" })),
}));

const actualFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
const readFile = jest.mocked(fs.readFile);
const lint = jest.mocked(runLinter);

async function validate(body: Record<string, unknown> = {}) {
    const req = Object.assign(new IncomingMessage(new Socket()), {
        method: "POST",
        headers: {},
        query: {},
        cookies: {},
        env: {},
        body: {
            file_content: "openapi: 3.0.3\ninfo: {title: Demo, version: v1}\npaths: {}\n",
            ...body,
        },
    });
    const res = Object.assign(new ServerResponse(req), {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        redirect: jest.fn().mockReturnThis(),
        setDraftMode: jest.fn().mockReturnThis(),
        setPreviewData: jest.fn().mockReturnThis(),
        clearPreviewData: jest.fn().mockReturnThis(),
        revalidate: jest.fn(async () => undefined),
    }) satisfies NextApiResponse;
    await handler(req, res);
    return res;
}

describe("/api/validate catalog integrity", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        readFile.mockImplementation(actualFs.readFile);
        jest.spyOn(console, "debug").mockImplementation(() => undefined);
        jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    test("returns the complete default catalog and all manual checks", async () => {
        const res = await validate();

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            rules: expect.objectContaining({
                auto_total: 67,
                auto_selected: 67,
                manual_total: 28,
                manual_selected: 28,
            }),
        }));
        expect(lint).toHaveBeenCalledTimes(1);
        expect(lint.mock.calls[0][1]).toHaveLength(67);
    });

    test.each([
        "public/rulesets/default/HTTPS_protocol.yaml",
        "public/manual-checklist/OAS_Compliance.yaml",
    ])("returns 500 instead of partial success for malformed %s", async (relativePath) => {
        const target = path.join(process.cwd(), relativePath);
        readFile.mockImplementation(async (file) => {
            if (file === target) return "rules: [";
            return actualFs.readFile(file, "utf8");
        });
        const res = await validate();

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: expect.stringContaining(`Invalid rule file "${target}"`),
        });
        expect(lint).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalled();
    });

    test("returns 500 for an unreadable rule file", async () => {
        readFile.mockImplementation(async (file) => {
            if (String(file).endsWith("HTTPS_protocol.yaml")) throw new Error("Access denied");
            return actualFs.readFile(file, "utf8");
        });
        const res = await validate();

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: expect.stringMatching(/Unable to load rule file.*Access denied/),
        });
        expect(lint).not.toHaveBeenCalled();
    });

    test("rejects an unknown implemented binding even if its rule is excluded", async () => {
        readFile.mockImplementation(async (file) => {
            const content = await actualFs.readFile(file, "utf8");
            return String(file).endsWith("HTTPS_protocol.yaml")
                ? content.replace("checkHttpsServers", "unknownFunction")
                : content;
        });
        const res = await validate({ exclude_auto_rules: ["COD-010-01-2507-2507-M"] });

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: expect.stringContaining('references unknown function "unknownFunction"'),
        });
        expect(lint).not.toHaveBeenCalled();
    });

    test("preserves rule selection, exclusions and full catalog totals", async () => {
        const res = await validate({
            auto_rules: ["COD-010-01-2507-2507-M", "BAS-110-01-2507-2507-M"],
            exclude_auto_rules: ["COD-010-01-2507-2507-M"],
        });

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            rules: expect.objectContaining({ auto_total: 67, auto_selected: 1, manual_total: 28 }),
        }));
        expect(lint.mock.calls[0][1]).toEqual([
            expect.objectContaining({ id: "BAS-110-01-2507-2507-M" }),
        ]);
    });

    test("preserves 400 for an unknown ruleset directory", async () => {
        const res = await validate({ ruleset: "nonexistent-t02-ruleset" });

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: "Ruleset folder not found: nonexistent-t02-ruleset",
        });
        expect(lint).not.toHaveBeenCalled();
    });
});
