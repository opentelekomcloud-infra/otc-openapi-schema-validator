import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getImplementedRules, parseRuleFile } from "@/lib/linter/ruleCatalog";
import { executionContextFor, type NativeExecutionContext } from "@/lib/openapi/executionContext";
import { classifyNativeOpenApiDocument } from "@/lib/openapi/parseNativeOpenApi";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { isRecord } from "@/lib/openapi/references";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { flowExampleContent, type Dialect } from "@/tests/fixtures/dual-version/scenarios";
import { createBaselineSession } from "@/lib/openapi/baseline";

jest.mock("@/utils/utils", () => ({
    ...jest.requireActual<typeof import("@/utils/utils")>("@/utils/utils"),
    fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn(),
}));

const catalog = getImplementedRules(
    fs.readdirSync("public/rulesets/default").filter((name) => name.endsWith(".yaml")).flatMap((name) =>
        parseRuleFile(fs.readFileSync(path.join("public/rulesets/default", name), "utf8"), name)),
    functionsMap,
);
const compliance = catalog.filter((rule) => ["checkOASVersion", "checkOASSpec"].includes(rule.call.function));

function freezeGraph(value: unknown): void {
    const pending = [value];
    const seen = new WeakSet<object>();
    while (pending.length) {
        const node = pending.pop();
        if (node === null || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        pending.push(...Object.values(node));
        Object.freeze(node);
    }
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native context tests must stay offline."));
});

test("pending startup probes skip immediately, then enable baseline loading after success", async () => {
    let finish: () => void = () => { throw new Error("Probe has not started"); };
    const probe = new Promise<void>((resolve) => { finish = resolve; });
    const unavailable = jest.fn();
    const session = createBaselineSession(unavailable, () => probe);
    const document = { openapi: "3.0.3", paths: {} };
    const pending = session.check(new AbortController().signal);
    await expect(session.load(document)).rejects.toThrow("temporarily skipped");
    expect(fetchRepoMap).not.toHaveBeenCalled();
    expect(fetchSpecFromGitea).not.toHaveBeenCalled();
    finish();
    await pending;
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "test" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(document);
    expect((await session.load(document)).document).toEqual(document);
    expect(unavailable).not.toHaveBeenCalled();
});

test("timed-out probes pause the first baseline request, and cancelled probes cannot pause a new attempt", async () => {
    const unavailable = jest.fn();
    const probe = jest.fn<Promise<void>, [AbortSignal]>().mockRejectedValue(new Error("Aborted"));
    const session = createBaselineSession(unavailable, probe);
    const controller = new AbortController();
    controller.abort();
    await session.check(controller.signal);
    expect(unavailable).toHaveBeenLastCalledWith("Gitea availability check timed out after 5 seconds.");
    await expect(session.load({})).rejects.toThrow("timed out");
    expect(fetchSpecFromGitea).not.toHaveBeenCalled();
    let fail: (error: Error) => void = () => { throw new Error("Probe has not started"); };
    probe.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const old = session.check(new AbortController().signal);
    session.reset();
    probe.mockResolvedValue(undefined);
    await session.check(new AbortController().signal);
    fail(new Error("Stale failure"));
    await old;
    expect(unavailable).toHaveBeenCalledTimes(1);
});

test("UI baseline failure pauses future requests until retry, without pausing API or unrelated checks", async () => {
    const unavailable = jest.fn();
    const session = createBaselineSession(unavailable);
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "test", filename: "test" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(null);
    const content = "openapi: 3.0.3\ninfo: {title: Test, version: v1}\npaths:\n  /v1/resources:\n    get:\n      responses:\n        '400': {description: Bad request}\n";
    const selected = catalog.filter((rule) => ["checkCompatibility", "checkIncompatibleChangeVersioning", "checkSuccessResponse"]
        .includes(rule.call.function));
    const first = await runLinter(content, selected, session.load);
    expect(first.diagnostics.filter((entry) => entry.ruleOutcome === "skip")).toHaveLength(8);
    expect(first.diagnostics.some((entry) => entry.message.includes("Missing: 200"))).toBe(true);
    const next = await runLinter(`# next file\n${content}`, selected, session.load);
    expect(next.diagnostics.filter((entry) => entry.ruleOutcome === "skip")).toHaveLength(8);
    expect(next.diagnostics.some((entry) => entry.message.includes("Missing: 200"))).toBe(true);
    expect(fetchRepoMap).toHaveBeenCalledTimes(1);
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);

    await runLinter(content, selected);
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(2);
    session.reset();
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(yaml.load(content));
    const recovered = await runLinter(content, selected, session.load);
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(3);
    expect(recovered.diagnostics.some((entry) => entry.ruleOutcome === "skip")).toBe(false);
    expect(recovered.diagnostics.some((entry) => entry.message.includes("Missing: 200"))).toBe(true);
});

test("missing mappings and invalid baseline documents do not pause Gitea for other specifications", async () => {
    const unavailable = jest.fn();
    const session = createBaselineSession(unavailable);
    const document = { openapi: "3.0.3", info: { title: "Test", version: "v1" }, paths: {} };
    jest.mocked(fetchRepoMap).mockResolvedValueOnce(null).mockResolvedValue({ reponame: "test" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValueOnce({ openapi: "3.1.0", paths: {} }).mockResolvedValue(document);
    await expect(session.load(document)).rejects.toThrow("mapping is unavailable");
    await expect(session.load(document)).rejects.toThrow("Invalid baseline specification");
    expect((await session.load(document)).document).toEqual(document);
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(2);
    expect(unavailable).not.toHaveBeenCalled();
});

test("a failed request started before explicit retry cannot pause the renewed session", async () => {
    const unavailable = jest.fn();
    const session = createBaselineSession(unavailable);
    const document = { openapi: "3.0.3", paths: {} };
    let finish: ((result: null) => void) | undefined;
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "test" });
    jest.mocked(fetchSpecFromGitea).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
        .mockResolvedValue(document);
    const old = session.load(document);
    const rejected = expect(old).rejects.toThrow("could not be loaded from Gitea");
    await Promise.resolve();
    session.reset();
    finish?.(null);
    await rejected;
    expect((await session.load(document)).document).toEqual(document);
    expect(unavailable).not.toHaveBeenCalled();
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

test.each([
    { content: 'swagger: "2.0"\ninfo: {title: Native}\npaths: {}', dialect: "swagger2", format: "yaml" },
    { content: 'swagger: 2\ninfo: {title: Native}\npaths: {}', dialect: "swagger2", format: "yaml" },
    { content: 'openapi: 3.0.3\ninfo: {title: Native}\npaths: {}', dialect: "openapi3", format: "yaml" },
    { content: '{swagger: "2.0", info: {title: Native}, paths: {}}', dialect: "swagger2", format: "yaml" },
    { content: '{"openapi":"3.0.3","info":{"title":"Native"},"paths":{}}', dialect: "openapi3", format: "json" },
    { content: '{"openapi":"3.0.3","info":{"title":"Native"},"paths":{},}', dialect: "openapi3", format: "yaml" },
])("shares one original document, classification and AST for $dialect/$format: $content", async ({ content, dialect, format }) => {
    const contexts: NativeExecutionContext[] = [];
    for (const name of ["checkOASVersion", "checkOASSpec"]) {
        const original = functionsMap[name];
        jest.spyOn(functionsMap, name).mockImplementation((document, text, rule, context) => {
            if (!context) throw new Error("Missing execution context.");
            contexts.push(context);
            expect(context.document).toBe(document);
            expect(context.originalContent).toBe(text);
            expect(text).toBe(content);
            expect(context.sourceFormat).toBe(format);
            expect(context.sourceDocument).toBe(sourceMap(text).sourceDocument);
            expect(executionContextFor(document)).toBe(context);
            expect(context.classification.ok).toBe(true);
            if (!context.classification.ok) throw context.classification.error;
            expect(classifyNativeOpenApiDocument(document)).toBe(context.classification.value);
            expect(context.native?.dialect).toBe(dialect);
            expect(context.native?.document).toBe(document);
            expect(context.native?.sourceDocument).toBe(context.sourceDocument);
            return original(document, text, rule, context);
        });
    }
    expect(await runLinter(content, compliance)).toEqual({ diagnostics: [], specTitle: "Native" });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(executionContextFor(contexts[0].document)).toBeUndefined();
    expect(contexts[0].document).toEqual(yaml.load(content, { json: true }));
});

test.each<Dialect>(["swagger2", "openapi3"])("%s CCE-shaped flow examples reach real rules with original text and native values", async (dialect) => {
    const content = flowExampleContent(dialect);
    const original = functionsMap.checkOASVersion;
    const version = jest.spyOn(functionsMap, "checkOASVersion").mockImplementation((document, text, rule, context) => {
        expect(text).toBe(content);
        expect(context?.originalContent).toBe(content);
        expect(context?.document).toBe(document);
        expect(context?.native?.dialect).toBe(dialect);
        expect(context?.sourceDocument.errors).toEqual([]);
        const schemas = dialect === "swagger2" ? document.definitions : document.components.schemas;
        expect(schemas.ChartValue.properties.values.example).toEqual({ basic: { name: "demo" }, items: [] });
        expect(schemas.Alias.$ref).toBe(`#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/ChartValue`);
        if (dialect === "swagger2") expect(document.openapi).toBeUndefined();
        return original(document, text, rule, context);
    });
    const success = catalog.find((rule) => rule.call.function === "checkSuccessResponse");
    if (!success) throw new Error("Missing success-response rule");
    const result = await runLinter(content, [...compliance, success]);
    expect(version).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toEqual([expect.objectContaining({
        source: expect.stringContaining(success.id), from: content.indexOf("get:"), lineNumber: 6,
        message: expect.stringContaining("Missing: 200"),
    })]);
});

test.each([
    "openapi: 3.1.0\ninfo: {}\npaths: {}",
    'swagger: "2.0"\nopenapi: 3.0.3\ninfo: {}\npaths: {}',
    "info: {}\npaths: {}",
    "null",
])("invalid classification preserves selected-rule execution rather than introducing a fatal version error: %s", async (content) => {
    const original = functionsMap.checkOASVersion;
    let captured: NativeExecutionContext | undefined;
    const version = jest.spyOn(functionsMap, "checkOASVersion").mockImplementation((document, text, rule, context) => {
        captured = context;
        if (!context || context.classification.ok) throw new Error("Expected explicit invalid classification.");
        expect(context.native).toBeUndefined();
        expect(() => classifyNativeOpenApiDocument(document)).toThrow(context.classification.error.message);
        return original(document, text, rule, context);
    });
    const unrelated = jest.spyOn(functionsMap, "checkHttpsServers").mockReturnValue([]);
    const transport = catalog.find((rule) => rule.call.function === "checkHttpsServers");
    if (!transport) throw new Error("Missing transport rule.");
    const result = await runLinter(content, [compliance[0], transport]);
    expect(version).toHaveBeenCalledTimes(1);
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].source).toContain(compliance[0].id);
    expect(result.diagnostics[0].source).not.toBe("parser");
    expect(result.diagnostics[0].source).not.toBe("version");
    expect(executionContextFor(captured?.document)).toBeUndefined();
});

test.each(["swagger2", "openapi3"])("all 67 bindings execute against the same frozen %s original without mutation", async (dialect) => {
    const document = dialect === "swagger2"
        ? { swagger: "2.0", info: { title: "Native", version: "v1" }, paths: { "/v1/resources": { get: { responses: { "200": { description: "OK", schema: { type: "object" } } } } } } }
        : { openapi: "3.0.3", info: { title: "Native", version: "v1" }, paths: { "/v1/resources": { get: { responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } } } } } };
    const content = JSON.stringify(document);
    freezeGraph(document);
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: `local-${dialect}`, filename: "baseline" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(document);
    const seen = new Set<string>();
    const contexts = new Set<NativeExecutionContext>();
    for (const name of new Set(catalog.map((rule) => rule.call.function))) {
        const original = functionsMap[name];
        jest.spyOn(functionsMap, name).mockImplementation((spec, text, rule, context) => {
            if (!context) throw new Error("Missing shared context.");
            freezeGraph(spec);
            seen.add(rule.id);
            contexts.add(context);
            expect(context.document).toBe(spec);
            expect(executionContextFor(spec)).toBe(context);
            return original(spec, text, rule, context);
        });
    }
    const result = await runLinter(content, catalog);
    expect(seen).toEqual(new Set(catalog.map((rule) => rule.id)));
    expect(seen.size).toBe(67);
    expect(contexts.size).toBe(1);
    expect(result.diagnostics.filter((finding) => finding.message.includes("execution failed"))).toEqual([]);
    const context = [...contexts][0];
    expect(context.document).toEqual(document);
    expect(executionContextFor(context.document)).toBeUndefined();
});

test("execution failure releases the context and later direct classification is not stale", async () => {
    let captured: NativeExecutionContext | undefined;
    jest.spyOn(functionsMap, "checkOASVersion").mockImplementation((_document, _text, _rule, context) => {
        captured = context;
        throw new Error("Expected rule failure.");
    });
    const result = await runLinter("openapi: 3.0.3\npaths: {}", [compliance[0]]);
    expect(result.diagnostics[0].message).toContain("Expected rule failure.");
    if (!captured || !isRecord(captured.document)) throw new Error("Missing captured document.");
    const document = captured.document;
    expect(executionContextFor(document)).toBeUndefined();
    document.openapi = "3.1.0";
    expect(() => classifyNativeOpenApiDocument(document)).toThrow("Unsupported");
});

test("concurrent documents retain separate scopes across asynchronous rule execution", async () => {
    const captured: NativeExecutionContext[] = [];
    jest.spyOn(functionsMap, "checkOASVersion").mockImplementation(async (document, _text, _rule, context) => {
        if (!context) throw new Error("Missing context.");
        captured.push(context);
        await Promise.resolve();
        expect(executionContextFor(document)).toBe(context);
        expect(context.native?.document).toBe(document);
        return [];
    });
    await Promise.all([
        runLinter('swagger: "2.0"\npaths: {}', [compliance[0]]),
        runLinter("openapi: 3.0.3\npaths: {}", [compliance[0]]),
    ]);
    expect(captured).toHaveLength(2);
    expect(captured[0]).not.toBe(captured[1]);
    expect(captured[0].document).not.toBe(captured[1].document);
    for (const context of captured) expect(executionContextFor(context.document)).toBeUndefined();
});
