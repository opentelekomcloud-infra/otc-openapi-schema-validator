import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { parseAllowedAbbreviations } from "@/lib/abbreviations";
import { setAllowedAbbreviations } from "@/utils/englishWords";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import { mapSeverity } from "@/utils/mapSeverity";
import { buildScenario, object, type Dialect, type JsonObject } from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Unexpected baseline lookup."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Unexpected baseline fetch."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native URI checks must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Native URI checks must not convert."); }),
}));
const cases = [
    { fn: "checkURIFormat", scenario: "uriFormat" },
    { fn: "checkURILength", scenario: "uriLength" },
    { fn: "checkURIContentDictionary", scenario: "uriDictionary" },
    { fn: "checkURIContentSyntax", scenario: "uriSyntax" },
    { fn: "checkURIContentSpecial", scenario: "uriSpecial" },
    { fn: "checkURIContentUnicode", scenario: "uriUnicode" },
    { fn: "checkURIResourceFormat", scenario: "uriPlural" },
    { fn: "checkURIContentComplexity", scenario: "uriDepth" },
    { fn: "checkCRUD", scenario: "crud" },
    { fn: "checkSuccessResponse", scenario: "successCode" },
    { fn: "checkQuotaApiPresence", scenario: "quota" },
] as const;
type Format = "json" | "quoted-yaml" | "flow";
const formats: Format[] = ["json", "quoted-yaml", "flow"];
const operations = ["checkCRUD", "checkSuccessResponse", "checkQuotaApiPresence", "checkURIResourceFormat"];
const rules = new Map<string, AutoRule>();
let abbreviations: string[];
beforeAll(async () => {
    const root = `${process.cwd()}/public/rulesets/default`;
    const files = ["Request_URI_Format", "Request_Verb_And_Response_Status_Code", "Requirements_for_query_operations"]
        .map((name) => `${root}/${name}.yaml`);
    const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.call.function, rule);
    abbreviations = parseAllowedAbbreviations(await fs.readFile(`${process.cwd()}/public/lib/allowed_abbreviations.txt`, "utf8"));
});
beforeEach(() => {
    setAllowedAbbreviations(abbreviations);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native URI checks must not access the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});
function ruleFor(fn: string, params: JsonObject = {}): AutoRule {
    const base = rules.get(fn);
    if (!base) throw new Error(`Missing URI/operation rule ${fn}`);
    return { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
}
function document(dialect: Dialect, paths: JsonObject, extra: JsonObject = {}): JsonObject {
    return { ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native URI contracts", version: "v1" }, paths, ...extra };
}
function text(spec: JsonObject, format: Format): string {
    if (format === "json") return JSON.stringify(spec);
    if (format === "flow") return yaml.dump(spec, { noRefs: true, flowLevel: 0 });
    const { paths, ...root } = spec;
    return yaml.dump(root, { noRefs: true, lineWidth: -1 }) + "paths:\n" + Object.entries(object(paths))
        .map(([path, item]) => `  ${JSON.stringify(path)}: ${JSON.stringify(item)}\n`).join("");
}
async function check(spec: JsonObject, rule: AutoRule, format: Format = "quoted-yaml", executionError = false) {
    const content = text(spec, format);
    const { diagnostics } = await runLinter(content, [rule]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.message.includes("execution failed")).toBe(executionError);
        expect(diagnostic.source === getSource(rule) || diagnostic.message.includes(rule.id)).toBe(true);
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
    }
    if (executionError) {
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].severity).toBe("error");
    }
    return { diagnostics, content };
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s native URI/operation contracts", (dialect) => {
    describe.each(cases)("$fn", ({ fn, scenario }) => {
        test.each(formats)("%s preserves positive/negative predicates and raw path-key policy", async (format) => {
            const rule = ruleFor(fn);
            for (const variant of ["positive", "negative"] as const) {
                const spec = buildScenario(scenario, dialect, variant, rule);
                if (dialect === "swagger2") spec.basePath = "/not-the-checked-uri";
                else spec.servers = [{ url: "https://example.invalid/not-the-checked-uri" }];
                const { diagnostics, content } = await check(spec, rule, format);
                expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
                if (variant === "negative" && fn.startsWith("checkURI")) {
                    expect(content.slice(diagnostics[0].from, diagnostics[0].to))
                        .toContain(Object.keys(object(spec.paths))[0]);
                }
            }
        });
        test("ignores Paths Object extensions and Path Item metadata", async () => {
            const spec = document(dialect, {
                ["x-preview.note/zzzxq/\u00e9/a/b/c/" + "a".repeat(2100)]: { get: true, post: true },
                "/v1/resources": { "x-preview": { get: {}, post: {} }, parameters: [], summary: "Metadata" },
            });
            if (fn === "checkQuotaApiPresence") {
                object(spec.paths)["/v1/quotas"] = { get: {} };
            }
            expect((await check(spec, ruleFor(fn))).diagnostics).toEqual([]);
        });
    });
    test.each(operations)("%s checks referenced Path Item contracts", async (fn) => {
        const path = fn === "checkQuotaApiPresence" ? "/v1/quotas" : "/v1/resource";
        const item: JsonObject = fn === "checkCRUD" ? { post: {} } : { get: { responses: { "400": {} } } };
        const spec = document(dialect, { [path]: { $ref: "#/x-path-items/Alias" } }, {
            "x-path-items": { Alias: { $ref: "#/x-path-items/Shared" }, Shared: item },
        });
        expect((await check(spec, ruleFor(fn))).diagnostics).toHaveLength(fn === "checkQuotaApiPresence" ? 0 : 1);
    });
    describe.each(operations)("%s necessary refs", (fn) => {
        test.each(["#/missing", "external.yaml#/Path", "#/x-path-items/Loop"])("%s is an explicit selected-rule error", async (reference) => {
            const path = fn === "checkQuotaApiPresence" ? "/v1/quotas" : "/v1/resources";
            const spec = document(dialect, { [path]: { $ref: reference } }, {
                "x-path-items": { Loop: { $ref: "#/x-path-items/Loop" } },
            });
            await check(spec, ruleFor(fn), "json", true);
        });
    });
    test.each(cases.filter(({ fn }) => fn.startsWith("checkURI") && fn !== "checkURIResourceFormat"))(
        "$fn path-only validation does not resolve Path Item references", async ({ fn, scenario }) => {
            const rule = ruleFor(fn);
            const spec = buildScenario(scenario, dialect, "negative", rule);
            const path = Object.keys(object(spec.paths))[0];
            spec.paths = { [path]: { $ref: "unneeded.yaml#/Path" } };
            expect((await check(spec, rule)).diagnostics).toHaveLength(1);
        },
    );
    test("CRUD requires actual operation objects, retaining same-path and optional-method policies", async () => {
        const spec = document(dialect, { "/v1/resources": { post: {}, get: null, put: null, delete: null } });
        expect((await check(spec, ruleFor("checkCRUD"))).diagnostics[0].message).toContain("Missing: get, put, delete");
        expect((await check(spec, ruleFor("checkCRUD", { optionalMethods: ["GET", "PUT", "DELETE"] }))).diagnostics).toEqual([]);
        object(spec.paths)["/v1/resources/{id}"] = { get: {}, put: {}, delete: {} };
        expect((await check(spec, ruleFor("checkCRUD"))).diagnostics).toHaveLength(1);
    });
    test.each(["/v1/resources", "/v1/*"])("CRUD exception %s excludes paths before ref resolution", async (exception) => {
        const spec = document(dialect, { "/v1/resources": { $ref: "excluded.yaml#/Path" } });
        expect((await check(spec, ruleFor("checkCRUD", { exceptionPaths: [exception] }))).diagnostics).toEqual([]);
    });
    test("status presence supports configured methods/codes without resolving response schemas", async () => {
        const spec = document(dialect, { "/v1/resources": {
            get: { responses: { "200": { $ref: "unneeded.yaml#/Response" }, "204": {} } },
            delete: { responses: { "204": {} } },
        } });
        expect((await check(spec, ruleFor("checkSuccessResponse"))).diagnostics).toEqual([]);
        expect((await check(spec, ruleFor("checkSuccessResponse", { requiredStatusCode: ["200", 204] }))).diagnostics).toEqual([]);
        expect((await check(spec, ruleFor("checkSuccessResponse", { method: ["GET", "delete"], requiredStatusCode: 200 }))).diagnostics)
            .toHaveLength(1);
    });
    test("quota matching excludes unrelated refs, rejects non-operations and retains suffix/trailing-slash behavior", async () => {
        const spec = document(dialect, {
            "/v1/resources": { $ref: "excluded.yaml#/Path" }, "/v1/quotas/": { get: true },
        });
        expect((await check(spec, ruleFor("checkQuotaApiPresence"))).diagnostics).toHaveLength(1);
        object(spec.paths)["/v1/quotas/"] = { get: {} };
        object(spec.paths)["/v2/quotas"] = { $ref: "not-needed-after-a-match.yaml#/Path" };
        expect((await check(spec, ruleFor("checkQuotaApiPresence"))).diagnostics).toEqual([]);
    });
    test("plural resource keeps verb tails, custom singular exceptions and five-method scope", async () => {
        const spec = document(dialect, {
            "/v1/resources/{id}/action": { post: {} }, "/v1/resource": { get: null, head: {}, options: {}, trace: {} },
        });
        expect((await check(spec, ruleFor("checkURIResourceFormat"))).diagnostics).toEqual([]);
        object(spec.paths)["/v1/status"] = { get: {} };
        expect((await check(spec, ruleFor("checkURIResourceFormat", { endsWithSButSingular: ["status"] }))).diagnostics).toHaveLength(1);
    });
    test("URI byte-length checks use the encoded path and exact configured threshold", async () => {
        const spec = document(dialect, { "/v1/\u00e9": {} });
        expect((await check(spec, ruleFor("checkURILength", { maxLength: 10 }))).diagnostics).toEqual([]);
        const { diagnostics } = await check(spec, ruleFor("checkURILength", { maxLength: 9 }));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("actual: 10");
    });
    test.each([
        { depth: 3, severity: undefined }, { depth: 4, severity: "medium" },
        { depth: 5, severity: "high" }, { depth: 6, severity: "critical" },
    ])("URI resource depth $depth retains configured severity boundaries", async ({ depth, severity }) => {
        const path = "/v1/" + Array.from({ length: depth }, (_, index) => `items${index}/{id${index}}`).join("/");
        const { diagnostics } = await check(document(dialect, { [path]: {} }), ruleFor("checkURIContentComplexity"));
        expect(diagnostics).toHaveLength(severity ? 1 : 0);
        if (severity) expect(diagnostics[0].severity).toBe(mapSeverity(severity));
    });
    test("percent and special-character policies retain their existing findings without global deduplication", async () => {
        const escaped = document(dialect, { "/v1/Resource_Names/%20": {} });
        expect((await check(escaped, ruleFor("checkURIContentSyntax"))).diagnostics).toEqual([]);
        expect((await check(document(dialect, { "/v1/%C3%A9": {} }), ruleFor("checkURIContentUnicode"))).diagnostics).toEqual([]);
        expect((await check(document(dialect, { "/v1/a.b.c": {} }), ruleFor("checkURIContentSpecial"))).diagnostics).toHaveLength(2);
        expect((await check(document(dialect, { "/v1/%zz": {} }), ruleFor("checkURIContentUnicode"))).diagnostics).toHaveLength(1);
    });
    test.each(cases)("$fn leaves frozen native documents and declarations unchanged", async ({ fn, scenario }) => {
        const rule = ruleFor(fn);
        const spec = buildScenario(scenario, dialect, "negative", rule);
        const before = JSON.stringify(spec);
        const pending: unknown[] = [spec];
        for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
            if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
                pending.push(...Object.values(item));
                Object.freeze(item);
            }
        }
        expect(await functionsMap[fn](spec, before, rule)).toHaveLength(1);
        expect(JSON.stringify(spec)).toBe(before);
    });
});
