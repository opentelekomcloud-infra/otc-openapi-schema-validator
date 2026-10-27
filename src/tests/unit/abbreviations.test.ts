import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { runPreparedLinter } from "@/lib/linter/runPreparedLinter";
import { parseAllowedAbbreviations, validateAllowedAbbreviations } from "@/lib/abbreviations";
import { readAllowedAbbreviations } from "@/lib/server/abbreviations";
import { getAllowedAbbreviations, looksLikeUnknownWord, setAllowedAbbreviations } from "@/utils/englishWords";
import { openApiLinter } from "@/components/Linter";
import validate from "@/pages/api/validate";
import abbreviationsApi from "@/pages/api/abbreviations";
import { requireApiAuth } from "@/lib/apiAuth";
import { getSource } from "@/functions/common";
import { array, object, type Dialect, type JsonObject } from "../fixtures/dual-version/scenarios";

jest.mock("@/lib/apiAuth", () => ({ requireApiAuth: jest.fn(async () => ({ mode: "disabled" })) }));
jest.mock("@/clients/gitea", () => ({ giteaClient: { fetchYamlFile: jest.fn() } }));
jest.mock("@/clients/reportportal", () => ({ reportPortalClient: { importLaunch: jest.fn() } }));
jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Unexpected baseline lookup."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Unexpected baseline fetch."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Dictionary initialization must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Dictionary initialization must not convert."); }),
}));

const dictionaryFunctions = [
    "checkCommonParameters", "checkParameterIsSnakeCase", "checkRootNodeMatchesResource", "checkURIContentDictionary",
];
const rules = new Map<string, AutoRule>();
const actualReadFile = fs.readFile;
let abbreviations: string[];
beforeAll(async () => {
    const root = `${process.cwd()}/public/rulesets/default`;
    const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml")).map((file) => `${root}/${file}`);
    const catalog = await loadRuleCatalog(files, (file) => actualReadFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.call.function, rule);
    abbreviations = parseAllowedAbbreviations(await actualReadFile(`${process.cwd()}/public/lib/allowed_abbreviations.txt`, "utf8"));
});
beforeEach(() => {
    jest.clearAllMocks();
    setAllowedAbbreviations(abbreviations);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network."));
});
afterEach(() => {
    expect(jest.mocked(globalThis.fetch).mock.calls.every(([url]) => url === "/api/abbreviations")).toBe(true);
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});
function ruleFor(fn: string): AutoRule {
    const rule = rules.get(fn);
    if (!rule) throw new Error(`Missing rule ${fn}`);
    return rule;
}
function document(dialect: Dialect, paths: JsonObject): JsonObject {
    return { ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Dictionary readiness", version: "v1" }, paths };
}
function request(body: JsonObject = {}, method = "POST") {
    const req = Object.assign(new IncomingMessage(new Socket()), {
        method, headers: {}, query: {}, cookies: {}, env: {}, body,
    }) satisfies NextApiRequest;
    const res = Object.assign(new ServerResponse(req), {
        status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
        redirect: jest.fn().mockReturnThis(), setDraftMode: jest.fn().mockReturnThis(), setPreviewData: jest.fn().mockReturnThis(),
        clearPreviewData: jest.fn().mockReturnThis(), revalidate: jest.fn(async () => undefined),
    }) satisfies NextApiResponse;
    return { req, res };
}
function view(content: string) {
    return { state: { doc: { toString: () => content } } };
}

test.each([
    { text: `"CDN", ' API ', "cdn"`, tokens: ["cdn", "api"] },
    { text: " CDN, API, cdn ", tokens: ["cdn", "api"] },
])("common parser preserves quoted/CSV formats with normalized unique tokens", ({ text, tokens }) => {
    expect(parseAllowedAbbreviations(text)).toEqual(tokens);
});
test.each([[], ["cdn", 5], [""], null, {}])("invalid API dictionary %j is explicit and atomic", (value) => {
    const before = getAllowedAbbreviations();
    expect(() => validateAllowedAbbreviations(value)).toThrow();
    expect(() => setAllowedAbbreviations(value)).toThrow();
    expect(getAllowedAbbreviations()).toEqual(before);
});
test.each(["", " , ", `""`])("empty dictionary text %j is not a successful empty list", (content) => {
    expect(() => parseAllowedAbbreviations(content)).toThrow();
});
test("server reader and public endpoint return exactly the same canonical dictionary", async () => {
    expect(await readAllowedAbbreviations()).toEqual(abbreviations);
    const { req, res } = request({}, "GET");
    await abbreviationsApi(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(abbreviations);
});
test("dictionary endpoint preserves authentication before file access", async () => {
    jest.mocked(requireApiAuth).mockResolvedValueOnce(null);
    const read = jest.spyOn(fs, "readFile");
    const { req, res } = request({}, "GET");
    await abbreviationsApi(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(read).not.toHaveBeenCalled();
});
test("public endpoint reports invalid dictionary instead of returning an empty successful payload", async () => {
    jest.spyOn(fs, "readFile").mockImplementation(async (file) => String(file).endsWith("allowed_abbreviations.txt")
        ? "" : actualReadFile(file, "utf8"));
    const { req, res } = request({}, "GET");
    await abbreviationsApi(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(console.error).toHaveBeenCalled();
});
test("browser readiness errors are scoped, failed loads retry and concurrent/cached lints share bootstrap", async () => {
    setAllowedAbbreviations(["placeholder"]);
    const selected = [ruleFor("checkURIContentDictionary"), ruleFor("checkSuccessResponse")];
    const content = JSON.stringify(document("openapi3", { "/v1/cdn": { get: { responses: { "400": {} } } } }));
    const lint = openApiLinter(selected);
    jest.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("", { status: 500 }));
    const failed = await lint(view(content));
    expect(failed.diagnostics).toHaveLength(2);
    expect(failed.diagnostics.some((diagnostic) => diagnostic.message.includes("unable to initialize allowed abbreviations"))).toBe(true);
    expect(failed.diagnostics.every((diagnostic) => diagnostic.source !== "parser")).toBe(true);

    let finish!: (response: Response) => void;
    jest.mocked(globalThis.fetch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    let settled = false;
    const first = lint(view(content)).then((result) => { settled = true; return result; });
    const second = lint(view(content));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    finish(new Response(JSON.stringify(abbreviations), { status: 200 }));
    for (const result of await Promise.all([first, second])) {
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0].source).toBe(getSource(selected[1]));
    }
    expect((await lint(view(content))).diagnostics).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});
test("non-dictionary selections require neither HTTP nor file readiness", async () => {
    const ready = jest.fn(async () => { throw new Error("Must not load."); });
    const selected = [ruleFor("checkSuccessResponse")];
    const content = JSON.stringify(document("openapi3", { "/v1/resources": { get: {} } }));
    expect((await runPreparedLinter(content, selected, ready)).diagnostics).toHaveLength(1);
    expect(ready).not.toHaveBeenCalled();
    expect((await openApiLinter(selected)(view(content))).diagnostics).toHaveLength(1);
    const read = jest.spyOn(fs, "readFile");
    const { req, res } = request({ file_content: content, auto_rules: selected.map((rule) => rule.id) });
    await validate(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(read.mock.calls.some(([file]) => String(file).endsWith("allowed_abbreviations.txt"))).toBe(false);
});
test.each([
    { fn: "checkURIContentDictionary", params: { checkAbreviations: false, checkDictionary: false } },
    { fn: "checkParameterIsSnakeCase", params: { validateAllowedAbbreviations: false, validateTokensAgainstDictionary: false } },
    { fn: "checkRootNodeMatchesResource", params: { useEnglishWordValidation: false } },
])("$fn with disabled lexical checks does not acquire a dictionary dependency", async ({ fn, params }) => {
    const base = ruleFor(fn);
    const selected = { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
    const ready = jest.fn(async () => { throw new Error("Must not load."); });
    const content = JSON.stringify(document("openapi3", { "/v1/resources": { get: {} } }));
    expect((await runPreparedLinter(content, [selected], ready)).diagnostics).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
});
test("a stalled browser bootstrap times out explicitly instead of blocking validation indefinitely", async () => {
    let words!: typeof import("@/utils/englishWords");
    jest.isolateModules(() => { words = jest.requireActual<typeof words>("@/utils/englishWords"); });
    jest.mocked(globalThis.fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    jest.useFakeTimers();
    try {
        const failed = expect(words.loadAllowedAbbreviationsFromApi()).rejects.toThrow("Timed out loading allowed abbreviations");
        await jest.advanceTimersByTimeAsync(10_000);
        await failed;
    } finally {
        jest.useRealTimers();
    }
});
test.each(["unreadable", "empty"])("API dictionary %s fails only dependent rules and retains all other findings", async (variant) => {
    jest.spyOn(fs, "readFile").mockImplementation(async (file) => {
        if (String(file).endsWith("allowed_abbreviations.txt")) {
            if (variant === "unreadable") throw new Error("Dictionary unavailable");
            return "";
        }
        return actualReadFile(file, "utf8");
    });
    const selected = [...dictionaryFunctions.map(ruleFor), ruleFor("checkSuccessResponse")];
    const { req, res } = request({
        file_content: JSON.stringify(document("openapi3", { "/v1/cdn": { get: {} } })),
        auto_rules: selected.map((rule) => rule.id),
    });
    await validate(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const diagnostics = array(object(res.json.mock.calls[0][0]).diagnostics).map(object);
    expect(diagnostics).toHaveLength(5);
    for (const selectedRule of selected) {
        expect(diagnostics.some((diagnostic) => diagnostic.source === getSource(selectedRule))).toBe(true);
    }
    expect(diagnostics.filter((diagnostic) => String(diagnostic.message).includes("unable to initialize allowed abbreviations")))
        .toHaveLength(4);
    expect(diagnostics.every((diagnostic) => diagnostic.source !== "parser")).toBe(true);
});
describe.each<Dialect>(["swagger2", "openapi3"])("%s dictionary parity", (dialect) => {
    test.each(dictionaryFunctions)("%s sees the same canonical inputs in prepared UI/API entrypoints", async (fn) => {
        const schema = { type: "object", properties: { resource: { type: "object" } } };
        const operation: JsonObject = fn === "checkRootNodeMatchesResource"
            ? dialect === "swagger2" ? { parameters: [{ name: "body", in: "body", schema }] }
                : { requestBody: { content: { "application/json": { schema } } } }
            : { parameters: [{ name: "cdn", in: "query", ...(dialect === "swagger2"
                ? { type: "string" } : { schema: { type: "string" } }) }] };
        const spec = document(dialect, { [fn === "checkRootNodeMatchesResource" || fn === "checkURIContentDictionary"
            ? "/v1/cdn" : "/v1/resources"]: { post: operation } });
        const content = JSON.stringify(spec);
        const selected = ruleFor(fn);
        jest.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify(abbreviations), { status: 200 }));
        const { req, res } = request({ file_content: content, auto_rules: [selected.id] });
        await validate(req, res);
        expect(res.status).toHaveBeenCalledWith(200);
        const api = array(object(res.json.mock.calls[0][0]).diagnostics).map(object);
        const ui = (await openApiLinter([selected])(view(content))).diagnostics;
        expect(api.map((diagnostic) => diagnostic.message)).toEqual(ui.map((diagnostic) => diagnostic.message));
        expect(ui).toHaveLength(fn === "checkRootNodeMatchesResource" ? 1 : 0);
    });
    test("rule-local URI overrides do not change dictionary checks or shared state in other rules", async () => {
        const base = ruleFor("checkURIContentDictionary");
        const custom = { ...base, call: { ...base.call, functionParams: {
            ...base.call.functionParams, allowedAbbreviations: ["qzcustom"],
        } } };
        const spec = document(dialect, { "/v1/qzcustom": {} });
        expect((await runLinter(JSON.stringify(spec), [custom])).diagnostics).toEqual([]);
        expect((await runLinter(JSON.stringify(spec), [base])).diagnostics).toHaveLength(1);
        expect(getAllowedAbbreviations().has("qzcustom")).toBe(false);
        expect(looksLikeUnknownWord("qzcustom")).toBe(true);
        const copy = getAllowedAbbreviations();
        copy.add("qzcustom");
        expect(getAllowedAbbreviations().has("qzcustom")).toBe(false);
    });
});
