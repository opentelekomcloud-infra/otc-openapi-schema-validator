import fs from "node:fs/promises";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";
import * as yaml from "js-yaml";
import validate, { config as validateConfig } from "@/pages/api/validate";
import convert, { config as convertConfig } from "@/pages/api/convert";
import { requireApiAuth } from "@/lib/apiAuth";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import type { NativeExecutionContext } from "@/lib/openapi/executionContext";
import { giteaClient } from "@/clients/gitea";
import { reportPortalClient } from "@/clients/reportportal";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { prepareOpenApiDocument } from "@/lib/openapi/prepareOpenApiDocument";
import { readFixtureContent, type Dialect } from "@/tests/fixtures/dual-version/scenarios";

jest.mock("node:fs/promises", () => {
    const actual = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    return { ...actual, readFile: jest.fn(actual.readFile) };
});
jest.mock("@/lib/apiAuth", () => ({ requireApiAuth: jest.fn(async () => ({ mode: "disabled" })) }));
jest.mock("@/clients/gitea", () => ({ giteaClient: { fetchRawYamlFile: jest.fn(), fetchYamlFile: jest.fn() } }));
jest.mock("@/clients/reportportal", () => ({ reportPortalClient: { importLaunch: jest.fn() } }));
jest.mock("@/utils/utils", () => ({ fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn() }));
jest.mock("@/lib/linter/runLinter", () => {
    const actual = jest.requireActual<typeof import("@/lib/linter/runLinter")>("@/lib/linter/runLinter");
    return { ...actual, runLinter: jest.fn(actual.runLinter) };
});
jest.mock("@/lib/openapi/prepareOpenApiDocument", () => ({
    prepareOpenApiDocument: jest.fn(() => { throw new Error("Native API must not prepare/convert input"); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native API must not convert"); }),
    convertObj: jest.fn(() => { throw new Error("Native API must not convert"); }),
}));

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
type Source = "file_content" | "url" | "disk" | "gitea";
const sources: Source[] = ["file_content", "url", "disk", "gitea"];
const versionId = "BAS-110-01-2507-2507-M";
const structureId = `${versionId}-1`;
const actualFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
const originalVersionCheck = functionsMap.checkOASVersion;
const contexts: NativeExecutionContext[] = [];

async function request(handler: Handler, body: unknown, method = "POST") {
    const req = Object.assign(new IncomingMessage(new Socket()), {
        method, headers: {}, query: {}, cookies: {}, env: {}, body,
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

function sourceBody(source: Source, content: string, dialect: Dialect = "swagger2"): Record<string, unknown> {
    if (source === "file_content") return { file_content: content };
    if (source === "url") {
        jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(content));
        return { path: "https://specs.example.invalid/native.yaml" };
    }
    if (source === "gitea") {
        jest.mocked(giteaClient.fetchRawYamlFile).mockResolvedValueOnce(content);
        return { path: "https://gitea.eco.example.invalid/docs/native/src/branch/main/openapi/spec.yaml" };
    }
    const diskPath = path.join(process.cwd(), "src/tests/fixtures/dual-version", `${dialect}.yaml`);
    jest.mocked(fs.readFile).mockImplementation(async (file) =>
        file === diskPath ? content : actualFs.readFile(file, "utf8"));
    return { path: diskPath };
}

beforeEach(() => {
    jest.clearAllMocks();
    contexts.length = 0;
    jest.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    jest.mocked(requireApiAuth).mockResolvedValue({ mode: "disabled" });
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "native", filename: "native" });
    jest.mocked(reportPortalClient.importLaunch).mockResolvedValue(JSON.stringify({ id: "native-launch" }));
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected native API network access"));
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(functionsMap, "checkOASVersion").mockImplementation((document, content, rule, context) => {
        if (context) contexts.push(context);
        return originalVersionCheck(document, content, rule, context);
    });
});
afterEach(() => {
    expect(prepareOpenApiDocument).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    expect(giteaClient.fetchYamlFile).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s original API sources", (dialect) => {
    test.each(sources)("%s executes all 67 native bindings with the untouched source and context", async (source) => {
        const content = `# original source\r\n${readFixtureContent(dialect).replace(/\r?\n/g, "\r\n")}`;
        jest.mocked(fetchSpecFromGitea).mockResolvedValue(yaml.load(content, { json: true }));
        const res = await request(validate, sourceBody(source, content, dialect));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(runLinter).toHaveBeenCalledTimes(1);
        expect(jest.mocked(runLinter).mock.calls[0][0]).toBe(content);
        expect(jest.mocked(runLinter).mock.calls[0][1]).toHaveLength(67);
        expect(contexts).toHaveLength(1);
        expect(contexts[0].originalContent).toBe(content);
        expect(contexts[0].classification).toMatchObject({ ok: true, value: { dialect } });
        expect(contexts[0].document).toHaveProperty(dialect === "swagger2" ? "definitions" : "components");
        if (dialect === "swagger2") expect(contexts[0].document).not.toHaveProperty("openapi");
        expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            conversion: { converted: false },
            diagnostics: expect.not.arrayContaining([expect.objectContaining({ message: expect.stringContaining("execution failed") })]),
            rules: expect.objectContaining({ auto_total: 67, auto_selected: 67, manual_total: 28, manual_selected: 28 }),
        }));
    });

    test.each(sources)("%s keeps duplicate declarations and exact original diagnostic offsets", async (source) => {
        const marker = dialect === "swagger2" ? "swagger: '2.0'" : "openapi: 3.0.3";
        const content = `# source comment\r\n${marker}\r\ninfo: {}\r\npaths:\r\n  /v1/resources:\r\n    get: {}\r\n    get: {}\r\n`;
        const res = await request(validate, { ...sourceBody(source, content, dialect), auto_rules: [versionId, structureId] });
        const from = content.indexOf("/v1/resources");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(jest.mocked(runLinter).mock.calls[0][0]).toBe(content);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            conversion: { converted: false },
            diagnostics: [expect.objectContaining({
                from, to: from + "/v1/resources".length, lineNumber: 5,
                message: expect.stringContaining("GET (2 declarations; lines 6, 7)"),
            })],
        }));
    });
});

test.each(sources)("%s parser failures return 400 with diagnostics and cannot create ReportPortal launches", async (source) => {
    const content = "# source\r\nswagger: [\r\n";
    const res = await request(validate, { ...sourceBody(source, content), auto_rules: [versionId], export: "xml" });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining("Specification parsing error"),
        conversion: { converted: false },
        diagnostics: [expect.objectContaining({ source: "parser", lineNumber: expect.any(Number) })],
        rules: expect.objectContaining({ auto_total: 67, auto_selected: 1 }),
    }));
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
});

test.each([
    'swagger: 2.0\ninfo: {}\npaths: {}\n',
    '{"swagger":"2.0","info":{},"paths":{},}',
    'swagger: "2.0"\ninfo: {}\npaths: {}\npaths: {}\n',
])("retains runtime numeric/flow/duplicate-key acceptance without converter repair: %s", async (content) => {
    const res = await request(validate, { file_content: content, auto_rules: [versionId] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ conversion: { converted: false }, diagnostics: [] }));
    expect(jest.mocked(runLinter).mock.calls[0][0]).toBe(content);
});

test.each(["openapi: 3.1.0", "openapi: 3.0.3\nswagger: '2.0'", "info: {}"])(
    "format errors stay selected-rule diagnostics, not a global HTTP version gate: %s", async (marker) => {
        const res = await request(validate, { file_content: `${marker}\npaths: {}\n`, auto_rules: [versionId] });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            diagnostics: [expect.objectContaining({ source: expect.stringContaining(versionId) })],
            conversion: { converted: false },
        }));
    },
);

test("native XML export preserves original lines, selected-rule failures, title and compatibility metadata", async () => {
    const content = "# original\r\nswagger: '2.0'\r\ninfo: {title: Native API, version: v1}\r\npaths:\r\n  /v1/resources:\r\n    get: {}\r\n    get: {}\r\n";
    const res = await request(validate, {
        file_content: content, auto_rules: [versionId, structureId], manual_rules: ["not-selected"], export: "xml",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(reportPortalClient.importLaunch).toHaveBeenCalledWith(expect.objectContaining({
        launch: "Service: Native API",
        xml: expect.stringContaining("Line 5:"),
    }));
    expect(jest.mocked(reportPortalClient.importLaunch).mock.calls[0][0].xml).toContain('status="FAIL"');
    expect(res.json).toHaveBeenCalledWith({ success: true, launch: { id: "native-launch" }, conversion: { converted: false } });
});

test("selection, exclusions and counts are unchanged for a native Swagger input", async () => {
    const res = await request(validate, {
        file_content: "swagger: '2.0'\ninfo: {}\npaths: {}\n",
        auto_rules: [versionId, structureId], exclude_auto_rules: [structureId],
        manual_rules: ["not-selected"],
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(jest.mocked(runLinter).mock.calls[0][1]).toEqual([expect.objectContaining({ id: versionId })]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        rules: expect.objectContaining({ auto_total: 67, auto_selected: 1, manual_total: 28, manual_selected: 0 }),
    }));
});

test("file_content retains precedence over a URL without any source fetch", async () => {
    const res = await request(validate, {
        file_content: "swagger: '2.0'\ninfo: {}\npaths: {}\n",
        path: "https://specs.example.invalid/ignored.yaml", auto_rules: [versionId],
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("missing baseline remains a selected-rule error on line one, not a global HTTP parser failure", async () => {
    jest.mocked(fetchRepoMap).mockResolvedValue(null);
    const res = await request(validate, {
        file_content: "swagger: '2.0'\ninfo: {}\npaths: {}\n",
        auto_rules: ["BAS-080-01-2507-2507-M"],
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        diagnostics: [expect.objectContaining({ from: 0, to: 0, lineNumber: 1, source: expect.stringContaining("BAS-080-") })],
    }));
});

test.each([validate, convert])("authentication and method checks precede source I/O for %p", async (handler) => {
    jest.mocked(requireApiAuth).mockResolvedValueOnce(null);
    expect((await request(handler, {})).status).toHaveBeenCalledWith(401);
    expect((await request(handler, {}, "GET")).status).toHaveBeenCalledWith(405);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runLinter).not.toHaveBeenCalled();
    expect(giteaClient.fetchRawYamlFile).not.toHaveBeenCalled();
});

test.each([{}, { file_content: "" }, { file_content: "swagger: [" }])("deprecated conversion POST returns 410 without inspecting or converting %j", async (body) => {
    const res = await request(convert, body);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining("/api/validate") });
    expect(runLinter).not.toHaveBeenCalled();
});

test("both endpoints retain the 10 MB body limit and native PDF export retains its existing statuses", async () => {
    expect(validateConfig.api.bodyParser.sizeLimit).toBe("10mb");
    expect(convertConfig.api.bodyParser.sizeLimit).toBe("10mb");
    const body = { file_content: "swagger: '2.0'\ninfo: {}\npaths: {}\n", auto_rules: [versionId], export: "pdf" };
    expect((await request(validate, body)).status).toHaveBeenCalledWith(400);
    expect((await request(validate, { ...body, out: "report.pdf" })).status).toHaveBeenCalledWith(501);
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
});
