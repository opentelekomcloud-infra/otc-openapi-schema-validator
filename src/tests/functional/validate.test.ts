import fs from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { NextApiRequest, NextApiResponse } from "next";
import * as yaml from "js-yaml";
import validate from "@/pages/api/validate";
import convert from "@/pages/api/convert";
import { requireApiAuth } from "@/lib/apiAuth";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { runPreparedLinter } from "@/lib/linter/runPreparedLinter";
import { loadAllowedAbbreviationsOnServer } from "@/lib/server/abbreviations";
import { giteaClient } from "@/clients/gitea";
import { reportPortalClient } from "@/clients/reportportal";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { getSeverityLabel } from "@/utils/mapSeverity";
import { coverageLedger } from "@/tests/fixtures/dual-version/coverageLedger";
import { readFixtureContent, type Dialect } from "@/tests/fixtures/dual-version/scenarios";

jest.mock("node:fs/promises", () => {
    const actual = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    return { ...actual, readFile: jest.fn(actual.readFile) };
});
jest.mock("@/lib/apiAuth", () => ({ requireApiAuth: jest.fn() }));
jest.mock("@/clients/gitea", () => ({ giteaClient: { fetchRawYamlFile: jest.fn(), fetchYamlFile: jest.fn() } }));
jest.mock("@/clients/reportportal", () => ({ reportPortalClient: { importLaunch: jest.fn() } }));
jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn(),
    convertMarkdownToPlainText: (value: string) => value,
}));
jest.mock("@/lib/linter/runLinter", () => ({
    ...jest.requireActual<typeof import("@/lib/linter/runLinter")>("@/lib/linter/runLinter"),
    runLinter: jest.fn(jest.requireActual<typeof import("@/lib/linter/runLinter")>("@/lib/linter/runLinter").runLinter),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("HTTP validation must not convert"); }),
    convertObj: jest.fn(() => { throw new Error("HTTP validation must not convert"); }),
}), { virtual: true });

type Source = "file_content" | "disk" | "url" | "gitea";
interface ApiResult {
    error?: string;
    success?: boolean;
    launch?: { id: string };
    conversion: { converted: boolean };
    diagnostics: { from: number; to: number; lineNumber: number; severity: string; source?: string; message: string }[];
    rules: {
        auto: AutoRule[]; manual: { id: string }[];
        auto_total: number; auto_selected: number; manual_total: number; manual_selected: number;
    };
}
const sources: Source[] = ["file_content", "disk", "url", "gitea"];
const versionId = "BAS-110-01-2507-2507-M";
const structureId = `${versionId}-1`;
const actualFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
const networkFetch = globalThis.fetch;
const directUrl = "https://specs.example.invalid/native.yaml";
let server: Server;
let origin: string;
let primaryContent: string;
let rules: AutoRule[];
const serverErrors: unknown[] = [];

function sourceBody(source: Source, content: string, dialect: Dialect): Record<string, unknown> {
    primaryContent = content;
    if (source === "file_content") return { file_content: content };
    if (source === "url") return { path: directUrl };
    if (source === "gitea") return { path: "https://gitea.eco.example.invalid/docs/native/src/branch/main/openapi/native.yaml" };
    return { path: path.join(process.cwd(), "src/tests/fixtures/dual-version", `${dialect}.yaml`) };
}

async function post(body: Record<string, unknown>, endpoint = "/api/validate") {
    const response = await fetch(`${origin}${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    return { status: response.status, json: await response.json() as ApiResult };
}

beforeAll(async () => {
    const root = path.join(process.cwd(), "public/rulesets/default");
    const files = (await actualFs.readdir(root)).filter((file) => file.endsWith(".yaml")).map((file) => path.join(root, file));
    rules = getImplementedRules(await loadRuleCatalog(files, (file) => actualFs.readFile(file, "utf8")), functionsMap);
    server = createServer((incoming, outgoing) => {
        const dispatch = async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const req = Object.assign(incoming, {
                body: text ? JSON.parse(text) : {}, query: {}, cookies: {}, env: {},
            }) satisfies NextApiRequest;
            const res: NextApiResponse = Object.assign(outgoing, {
                status(code: number) { outgoing.statusCode = code; return res; },
                json(value: unknown) {
                    outgoing.setHeader("Content-Type", "application/json");
                    outgoing.end(JSON.stringify(value));
                    return res;
                },
                send(value: string) { outgoing.end(value); return res; },
                redirect() { outgoing.end(); return res; },
                setDraftMode() { return res; }, setPreviewData() { return res; },
                clearPreviewData() { return res; }, async revalidate() { return undefined; },
            }) satisfies NextApiResponse;
            if (incoming.url === "/api/validate") await validate(req, res);
            else if (incoming.url === "/api/convert") await convert(req, res);
            else { outgoing.statusCode = 404; outgoing.end(); }
        };
        void dispatch().catch((error: unknown) => {
            serverErrors.push(error);
            outgoing.statusCode = 500;
            outgoing.end("Isolated HTTP harness failure");
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an owned loopback server");
    origin = `http://127.0.0.1:${address.port}`;
    expect((await networkFetch(`${origin}/api/validate`)).status).toBe(401);
});
afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => {
    jest.clearAllMocks();
    serverErrors.length = 0;
    primaryContent = "";
    jest.mocked(requireApiAuth).mockResolvedValue({ mode: "disabled" });
    jest.mocked(reportPortalClient.importLaunch).mockResolvedValue('{"id":"isolated-launch"}');
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "native", filename: "native" });
    jest.mocked(fetchSpecFromGitea).mockImplementation(async () => yaml.load(primaryContent, { json: true }));
    jest.mocked(giteaClient.fetchRawYamlFile).mockImplementation(async () => primaryContent);
    jest.mocked(fs.readFile).mockImplementation(async (file) =>
        typeof file === "string" && /dual-version[/\\](swagger2|openapi3)\.yaml$/.test(file)
            ? primaryContent : actualFs.readFile(file, "utf8"));
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith(`${origin}/`)) return networkFetch(input, init);
        if (url === directUrl) return new Response(primaryContent);
        throw new Error(`Unexpected external HTTP request: ${url}`);
    });
});
afterEach(() => {
    expect(serverErrors).toEqual([]);
    expect(giteaClient.fetchYamlFile).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

test("the HTTP catalog matches all 67 ledger IDs, 47 functions and 28 manual checks", async () => {
    const { status, json } = await post(sourceBody("file_content", readFixtureContent("swagger2"), "swagger2"));
    expect(status).toBe(200);
    expect(json.rules).toMatchObject({ auto_total: 67, auto_selected: 67, manual_total: 28, manual_selected: 28 });
    expect(json.rules.auto.map((rule) => rule.id).sort()).toEqual(coverageLedger.map((entry) => entry.ruleId).sort());
    expect(new Set(json.rules.auto.map((rule) => rule.call.function)).size).toBe(47);
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s isolated native HTTP sources", (dialect) => {
    test.each(sources)("%s matches real engine findings and preserves the original source", async (source) => {
        const content = readFixtureContent(dialect);
        const body = sourceBody(source, content, dialect);
        const expected = await runPreparedLinter(content, rules, loadAllowedAbbreviationsOnServer);
        jest.mocked(runLinter).mockClear();
        const { status, json } = await post(body);
        expect(status).toBe(200);
        expect(json.conversion).toEqual({ converted: false });
        expect(json.diagnostics).toEqual(expected.diagnostics.map((diagnostic) => ({
            ...diagnostic, severity: getSeverityLabel(diagnostic.severity),
        })));
        expect(json.diagnostics).toHaveLength(14);
        expect(json.diagnostics.some((diagnostic) => diagnostic.message.includes("execution failed"))).toBe(false);
        expect(runLinter).toHaveBeenCalledTimes(1);
        expect(jest.mocked(runLinter).mock.calls[0][0]).toBe(content);
        expect(jest.mocked(runLinter).mock.calls[0][1].map((rule: AutoRule) => rule.id).sort())
            .toEqual(coverageLedger.map((entry) => entry.ruleId).sort());
        expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
        if (source === "gitea") {
            expect(giteaClient.fetchRawYamlFile).toHaveBeenCalledWith("native", "openapi/native.yaml", "main");
        }
    });

    test.each(sources)("%s returns the exact authored duplicate-key diagnostic", async (source) => {
        const marker = dialect === "swagger2" ? "swagger: '2.0'" : "openapi: 3.0.3";
        const content = `# source\r\n${marker}\r\ninfo: {}\r\npaths:\r\n  /v1/resources:\r\n    get: {}\r\n    get: {}\r\n`;
        const { status, json } = await post({ ...sourceBody(source, content, dialect), auto_rules: [versionId, structureId] });
        expect(status).toBe(200);
        const from = content.indexOf("/v1/resources");
        expect(json.diagnostics).toEqual([expect.objectContaining({
            from, to: from + "/v1/resources".length, lineNumber: 5,
            source: expect.stringContaining(structureId),
            message: expect.stringContaining("GET (2 declarations; lines 6, 7)"),
        })]);
        expect(json.rules.auto_selected).toBe(2);
    });

    test.each(sources)("%s XML export contains every selected ID exactly once and cannot falsely pass failures", async (source) => {
        const content = readFixtureContent(dialect);
        const { status, json } = await post({ ...sourceBody(source, content, dialect), export: "xml" });
        expect(status).toBe(200);
        expect(json).toEqual({ success: true, launch: { id: "isolated-launch" }, conversion: { converted: false } });
        expect(reportPortalClient.importLaunch).toHaveBeenCalledTimes(1);
        const xml = jest.mocked(reportPortalClient.importLaunch).mock.calls[0][0].xml;
        expect(xml.match(/<test id="[^"]+" name="Rule /g)).toHaveLength(67);
        expect(xml.match(/<status status="SKIP" /g)).toHaveLength(29); // 28 manual cases and their suite
        for (const rule of rules) expect(xml.match(new RegExp(`name="Rule ${rule.id}(?: -|")`, "g"))).toHaveLength(1);
        expect(xml).not.toContain("execution failed");
        expect(xml).toContain("Line ");
    });
});

test.each(sources)("%s parser failures return 400 and never call ReportPortal", async (source) => {
    const { status, json } = await post({
        ...sourceBody(source, "swagger: [", "swagger2"), auto_rules: [versionId], export: "xml",
    });
    expect(status).toBe(400);
    expect(json.diagnostics).toEqual([expect.objectContaining({ source: "parser", severity: getSeverityLabel("error") })]);
    expect(json.error).toContain("Specification parsing error");
    expect(json).not.toHaveProperty("launch");
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
});

test("include/exclude and source precedence preserve precise counts", async () => {
    const { status, json } = await post({
        file_content: readFixtureContent("swagger2"), path: directUrl,
        auto_rules: [versionId, structureId], exclude_auto_rules: [structureId],
        manual_rules: ["not-selected"],
    });
    expect(status).toBe(200);
    expect(json.diagnostics).toEqual([]);
    expect(json.rules).toMatchObject({ auto_total: 67, auto_selected: 1, manual_total: 28, manual_selected: 0 });
    expect(json.rules.auto.map((rule) => rule.id)).toEqual([versionId]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("manual include/exclude uses actual checklist IDs and retains all 28 loaded checks", async () => {
    const content = readFixtureContent("swagger2");
    const initial = await post({ file_content: content, auto_rules: [versionId] });
    const selected = initial.json.rules.manual.slice(0, 2).map((rule) => rule.id);
    expect(selected).toHaveLength(2);
    const { status, json } = await post({
        file_content: content, auto_rules: [versionId],
        manual_rules: selected, exclude_manual_rules: [selected[1]],
    });
    expect(status).toBe(200);
    expect(json.rules.manual.map((rule) => rule.id)).toEqual([selected[0]]);
    expect(json.rules).toMatchObject({ manual_total: 28, manual_selected: 1, auto_selected: 1 });
});

test.each(["url", "gitea", "disk"] as const)("%s source unavailability is HTTP 400 before any rule or export runs", async (source) => {
    const body = sourceBody(source, readFixtureContent("swagger2"), "swagger2");
    if (source === "gitea") {
        jest.mocked(giteaClient.fetchRawYamlFile).mockRejectedValue(new Error("Failed to fetch file from Gitea: HTTP 404"));
    } else if (source === "disk") {
        body.path = path.join(process.cwd(), "src/tests/fixtures/dual-version/not-found.yaml");
    } else {
        const guardedFetch = jest.mocked(globalThis.fetch).getMockImplementation();
        if (!guardedFetch) throw new Error("Missing isolated fetch guard");
        jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
            String(input) === directUrl ? Promise.resolve(new Response("Not found", { status: 404 })) : guardedFetch(input, init));
    }
    const { status, json } = await post({ ...body, export: "xml" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/HTTP 404|Cannot access path/);
    expect(json).not.toHaveProperty("diagnostics");
    expect(runLinter).not.toHaveBeenCalled();
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
});

test("invalid catalog bindings are explicit HTTP failures, never a partial successful ruleset", async () => {
    jest.mocked(fs.readFile).mockImplementation(async (file) => {
        const text = await actualFs.readFile(file, "utf8");
        return String(file).endsWith("HTTPS_protocol.yaml") ? text.replace("checkHttpsServers", "missingNativeFunction") : text;
    });
    const { status, json } = await post({ file_content: readFixtureContent("swagger2") });
    expect(status).toBe(500);
    expect(json.error).toContain("missingNativeFunction");
    expect(runLinter).not.toHaveBeenCalled();
});

test("missing baseline retains eight selected errors, not a document error or false successful export", async () => {
    jest.mocked(fetchRepoMap).mockResolvedValue(null);
    const auto = rules.filter((rule) => rule.id.startsWith("BAS-080-") || rule.id === "VER-030-01-2507-2507-O-5");
    const { status, json } = await post({
        file_content: readFixtureContent("swagger2"), auto_rules: auto.map((rule) => rule.id),
    });
    expect(status).toBe(200);
    expect(json.diagnostics).toHaveLength(8);
    expect(json.diagnostics.every((diagnostic) => diagnostic.from === 0 && diagnostic.to === 0 && diagnostic.lineNumber === 1)).toBe(true);
    const exported = await post({
        file_content: readFixtureContent("swagger2"), auto_rules: auto.map((rule) => rule.id), export: "xml",
    });
    expect(exported.status).toBe(200);
    const xml = jest.mocked(reportPortalClient.importLaunch).mock.calls[0][0].xml;
    expect(xml.match(/<test id="[^"]+" name="Rule /g)).toHaveLength(8);
    expect(xml.split('name="Passed Rules"')[1].split("</suite>")[0]).not.toContain("<test ");
});

test.each(["openapi: 3.1.0", "openapi: 3.0.3\nswagger: '2.0'", "info: {}"])(
    "version policy remains selected-compliance rather than a global gate: %s", async (marker) => {
        const { status, json } = await post({ file_content: `${marker}\npaths: {}`, auto_rules: [versionId] });
        expect(status).toBe(200);
        expect(json.diagnostics).toEqual([expect.objectContaining({ source: expect.stringContaining(versionId) })]);
    },
);

test.each(["null", "[]", "5"])("parseable non-document %s remains a selected-rule format error with HTTP 200", async (content) => {
    const { status, json } = await post({ file_content: content, auto_rules: [versionId] });
    expect(status).toBe(200);
    expect(json.diagnostics).toEqual([expect.objectContaining({ source: expect.stringContaining(versionId) })]);
    expect(json.error).toBeUndefined();
    expect(json.conversion).toEqual({ converted: false });
});

test("auth rejection precedes source access; retired conversion and method statuses remain intact", async () => {
    jest.mocked(requireApiAuth).mockResolvedValueOnce(null);
    expect((await post({ path: directUrl })).status).toBe(401);
    expect(runLinter).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/api/validate`)).status).toBe(405);
    expect((await post({ file_content: "swagger: [" }, "/api/convert")).status).toBe(410);
});

test("ReportPortal import errors return HTTP 500 without success-shaped metadata", async () => {
    jest.mocked(reportPortalClient.importLaunch).mockRejectedValue(new Error("Controlled import failure"));
    const { status, json } = await post({
        file_content: readFixtureContent("swagger2"), auto_rules: [versionId], export: "xml",
    });
    expect(status).toBe(500);
    expect(json.error).toBe("Controlled import failure");
    expect(json).not.toHaveProperty("success");
});
