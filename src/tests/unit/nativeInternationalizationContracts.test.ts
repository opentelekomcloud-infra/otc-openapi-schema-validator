import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import { object, type Dialect, type JsonObject } from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Unexpected baseline lookup."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Unexpected baseline fetch."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native i18n must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Native i18n must not convert."); }),
}));

type Format = "yaml" | "flow" | "json";
const formats: Format[] = ["yaml", "flow", "json"];
const chinese = "\u4e2d\u6587";
let baseRule: AutoRule;
beforeAll(async () => {
    const catalog = await loadRuleCatalog([`${process.cwd()}/public/rulesets/default/Internationalization.yaml`],
        (file) => fs.readFile(file, "utf8"));
    [baseRule] = getImplementedRules(catalog, functionsMap);
    expect(baseRule.id).toBe("INT-010-01-2507-2507-M");
});
beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native i18n must not access the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const baseline = jest.requireMock<{ fetchRepoMap: jest.Mock; fetchSpecFromGitea: jest.Mock }>("@/utils/utils");
    expect(baseline.fetchRepoMap).not.toHaveBeenCalled();
    expect(baseline.fetchSpecFromGitea).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});
function document(dialect: Dialect, extra: JsonObject = {}): JsonObject {
    return { ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native internationalization", version: "v1" }, paths: {}, ...extra };
}
function section(spec: JsonObject, dialect: Dialect, kind: "schemas" | "parameters" | "responses" | "securitySchemes", value: JsonObject) {
    if (dialect === "swagger2") {
        spec[kind === "schemas" ? "definitions" : kind === "securitySchemes" ? "securityDefinitions" : kind] = value;
    } else {
        if (spec.components === undefined) spec.components = {};
        object(spec.components)[kind] = value;
    }
}
function rule(params: JsonObject = {}, locations?: string[], elements?: string[]): AutoRule {
    return { ...baseRule, ...(locations ? { location: locations } : {}), ...(elements ? { element: elements } : {}),
        call: { ...baseRule.call, functionParams: { ...baseRule.call.functionParams, ...params } } };
}
async function checkContent(content: string, selected: AutoRule = baseRule, executionError = false) {
    const { diagnostics } = await runLinter(content, [selected]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.source).toBe(getSource(selected));
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
        expect(diagnostic.message.includes("execution failed")).toBe(executionError);
    }
    if (executionError) {
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].severity).toBe("error");
    }
    return diagnostics;
}
async function check(spec: JsonObject, format: Format = "yaml", selected: AutoRule = baseRule) {
    const content = format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, lineWidth: -1, ...(format === "flow" ? { flowLevel: 0 } : {}) });
    return checkContent(content, selected);
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s native internationalization", (dialect) => {
    describe.each(["schemas", "parameters", "responses", "securitySchemes"] as const)("%s reusable scope", (kind) => {
        test.each(formats)("%s finds forbidden text but accepts English in the equivalent native section", async (format) => {
            const spec = document(dialect);
            const shared: JsonObject = kind === "schemas" ? { type: "object", properties: { id: { type: "string", description: chinese } } }
                : kind === "parameters" ? { name: "filter", in: "query", description: chinese, ...(dialect === "swagger2"
                    ? { type: "string" } : { schema: { type: "string" } }) }
                    : kind === "securitySchemes" ? { type: "apiKey", name: "Token", in: "header", description: chinese }
                        : { description: chinese };
            section(spec, dialect, kind, { Shared: shared });
            const findings = await check(spec, format);
            expect(findings).toHaveLength(1);
            expect(findings[0].message).toContain(dialect === "swagger2"
                ? `/${kind === "schemas" ? "definitions" : kind === "securitySchemes" ? "securityDefinitions" : kind}/Shared`
                : `/components/${kind}/Shared`);
            if (kind === "schemas") object(object(shared.properties).id).description = "Resource identifier";
            else shared.description = "Shared contract";
            expect(await check(spec, format)).toEqual([]);
        });
    });
    test("info and tags remain selected while paths/operation prose remain excluded", async () => {
        const spec = document(dialect, { info: { title: chinese, version: "v1" },
            tags: [{ name: chinese, description: "English tag" }],
            paths: { "/v1/resources": { get: { summary: chinese, description: chinese } } } });
        expect(await check(spec)).toHaveLength(2);
        expect(await check(spec, "json", rule({}, ["components"]))).toEqual([]);
        expect(await check(spec, "yaml", rule({}, ["info"]))).toHaveLength(1);
        expect(await check(spec, "yaml", rule({}, ["tags"]))).toHaveLength(1);
    });
    test("element filters, empty-element defaults and language switches retain their semantics", async () => {
        const spec = document(dialect, { info: { title: chinese, description: chinese } });
        expect(await check(spec, "json", rule({}, undefined, ["description"]))).toHaveLength(1);
        expect(await check(spec, "json", rule({}, undefined, []))).toHaveLength(2);
        expect(await check(spec, "json", rule({ forbiddenLanguages: [] }))).toEqual([]);
        expect(await check(spec, "json", rule({ forbiddenLanguages: ["ZH"] }))).toHaveLength(2);
    });
    test("other languages are not newly rejected and the configured Unicode range still applies", async () => {
        const spec = document(dialect, { info: { title: "\u0422\u0435\u0441\u0442", version: "v1" } });
        expect(await check(spec)).toEqual([]);
        expect(await check(spec, "json", rule({ forbiddenUnicodeRange: "\\u0400-\\u04FF" }))).toHaveLength(1);
    });
    test("only configured text keys are inspected, without resolving literal or external $ref strings", async () => {
        const spec = document(dialect);
        section(spec, dialect, "schemas", { Shared: { $ref: "external.yaml#/Shared", type: "object",
            enum: [chinese], example: { $ref: "external.yaml#/Payload", value: chinese, name: chinese } } });
        const findings = await check(spec);
        expect(findings).toHaveLength(1);
        expect(findings[0].message).toContain("/example/name");
    });
    test("missing reusable sections and selected locations are empty scopes", async () => {
        expect(await check(document(dialect))).toEqual([]);
        expect(await check(document(dialect, { info: { title: chinese } }), "yaml", rule({}, []))).toEqual([]);
    });
    test("frozen native declarations and source data remain unchanged", async () => {
        const spec = document(dialect);
        const shared = { description: chinese };
        section(spec, dialect, "responses", { Shared: shared });
        const content = JSON.stringify(spec);
        Object.freeze(shared);
        Object.freeze(spec);
        expect(await functionsMap[baseRule.call.function](spec, content, baseRule)).toHaveLength(1);
        expect(JSON.stringify(spec)).toBe(content);
    });
});

test("repeated YAML aliases retain separate semantic findings, without global deduplication", async () => {
    const content = `openapi: 3.0.3
info: { title: Native aliases, version: v1 }
paths: {}
components:
  schemas:
    First: &shared
      description: "${chinese}"
    Second: *shared
`;
    const findings = await checkContent(content);
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain("/components/schemas/First/description");
    expect(findings[1].message).toContain("/components/schemas/Second/description");
});
test("cyclic metadata becomes an explicit selected-rule error rather than recursive traversal failure", async () => {
    const content = `swagger: "2.0"
info: { title: Native cycle, version: v1 }
paths: {}
definitions:
  Shared: &shared
    description: English
    child: *shared
`;
    const findings = await checkContent(content, baseRule, true);
    expect(findings[0].message).toContain("Cyclic metadata object");
});
test("direct metadata walking supports deep declarations independently of runtime parser depth limits", async () => {
    const root: JsonObject = {};
    let current = root;
    for (let index = 0; index < 300; index++) {
        const child: JsonObject = {};
        current.child = child;
        current = child;
    }
    current.description = chinese;
    const spec = document("swagger2", { definitions: { Shared: root } });
    const findings = await functionsMap[baseRule.call.function](spec, JSON.stringify(spec), baseRule);
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe(getSource(baseRule));
    expect(findings[0].message).toContain("/description");
});
