import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import { object, type Dialect, type JsonObject } from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Native time checks must not fetch baselines."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Native time checks must not fetch baselines."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native time checks must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Native time checks must not convert."); }),
}), { virtual: true });

type Format = "yaml" | "flow" | "json";
const formats: Format[] = ["yaml", "flow", "json"];
const timeFormat = "TIM-010-01-2507-2507-M-1";
const timeName = "TIM-010-01-2507-2507-M-2";
const rules = new Map<string, AutoRule>();
beforeAll(async () => {
    const catalog = await loadRuleCatalog([`${process.cwd()}/public/rulesets/default/Time_format.yaml`],
        (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.id, rule);
    expect(rules.size).toBe(2);
});
beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native time checks must not access the network."));
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
        info: { title: "Native time contracts", version: "v1" }, paths: {}, ...extra };
}
function definitions(spec: JsonObject, dialect: Dialect): JsonObject {
    if (dialect === "swagger2") {
        if (spec.definitions === undefined) spec.definitions = {};
        return object(spec.definitions);
    }
    if (spec.components === undefined) spec.components = {};
    const components = object(spec.components);
    if (components.schemas === undefined) components.schemas = {};
    return object(components.schemas);
}
function schemaRef(dialect: Dialect, name: string): JsonObject {
    return { $ref: `#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/${name}` };
}
function request(dialect: Dialect, schema: JsonObject): JsonObject {
    return dialect === "swagger2" ? { parameters: [{ in: "body", name: "body", schema }] }
        : { requestBody: { content: { "application/json": { schema } } } };
}
function response(dialect: Dialect, schema: JsonObject): JsonObject {
    return { description: "OK", ...(dialect === "swagger2" ? { schema } : { content: { "application/json": { schema } } }) };
}
function ruleFor(id: string, params: JsonObject = {}): AutoRule {
    const base = rules.get(id);
    if (!base) throw new Error(`Missing time rule ${id}`);
    return { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
}
function text(spec: JsonObject, format: Format): string {
    return format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, lineWidth: -1, ...(format === "flow" ? { flowLevel: 0 } : {}) });
}
async function check(spec: JsonObject, id: string, params: JsonObject = {}, format: Format = "yaml", executionError = false) {
    const rule = ruleFor(id, params);
    const content = text(spec, format);
    const { diagnostics } = await runLinter(content, [rule]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.source).toBe(getSource(rule));
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
        expect(diagnostic.message.includes("execution failed")).toBe(executionError);
    }
    if (executionError) {
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].severity).toBe("error");
    }
    return { diagnostics, content };
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s native time contracts", (dialect) => {
    test.each(formats)("%s global time format checks valid/invalid examples in their original source", async (format) => {
        const spec = document(dialect);
        definitions(spec, dialect).Resource = { properties: {
            created_at: { type: "string", example: "2026-01-01T00:00:00Z" },
            updated_at: { type: "string", example: "not-a-date" },
        } };
        const { diagnostics, content } = await check(spec, timeFormat, {}, format);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('Found example for "updated_at"');
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toContain("not-a-date");
    });
    test.each(formats)("%s global naming handles nested schemas, compositions, arrays and maps", async (format) => {
        const spec = document(dialect);
        definitions(spec, dialect).Resource = {
            allOf: [{ properties: { create_time: { type: "string" } } }],
            properties: {
                created_at: { type: "string" },
                details: { properties: { updatedAt: { type: "string" } } },
                items: { type: "array", items: { properties: { delete_time: { type: "string" } } } },
                entries: { type: "object", additionalProperties: { properties: { expire_time: { type: "string" } } } },
            },
        };
        const { diagnostics } = await check(spec, timeName, {}, format);
        expect(diagnostics).toHaveLength(4);
        for (const name of ["create_time", "updatedAt", "delete_time", "expire_time"]) {
            expect(diagnostics.some((diagnostic) => diagnostic.message.includes(`Found "${name}"`))).toBe(true);
        }
    });
    test.each(["2020-09-01", "2020-09-01 18:50:20", "2020-09-01T18:50:20+08:00"])(
        "preserves Date.parse fallback and valid offsets: %s", async (example) => {
            const spec = document(dialect);
            definitions(spec, dialect).Resource = { properties: { created_at: { example } } };
            expect((await check(spec, timeFormat)).diagnostics).toEqual([]);
        },
    );
    test.each(["", "  ", "not-a-date", null, false, 0])("rejects the same invalid example value %j", async (example) => {
        const spec = document(dialect);
        definitions(spec, dialect).Resource = { properties: { created_at: { example } } };
        expect((await check(spec, timeFormat)).diagnostics).toHaveLength(1);
    });
    test("timezone scope stays direct-global-property-only and case-insensitive", async () => {
        const spec = document(dialect);
        definitions(spec, dialect).Resource = { properties: {
            CREATED_AT: { example: "not-a-date" }, arbitrary_time: { example: "not-a-date" },
            details: { properties: { updated_at: { example: "not-a-date" } } },
        } };
        spec.paths = { "/v1/resources": { post: request(dialect, { properties: {
            expired_at: { example: "not-a-date" },
        } }) } };
        const { diagnostics } = await check(spec, timeFormat);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('"CREATED_AT"');
    });
    test("missing global containers and examples are not execution errors", async () => {
        const spec = document(dialect);
        for (const id of [timeFormat, timeName]) expect((await check(spec, id)).diagnostics).toEqual([]);
        definitions(spec, dialect).Resource = { properties: { created_at: { type: "string" } } };
        expect((await check(spec, timeFormat)).diagnostics).toEqual([]);
    });
    test("invalid configured regexp fails the selected time-format rule instead of silently passing", async () => {
        const spec = document(dialect);
        await check(spec, timeFormat, { preferredFormat: "[" }, "json", true);
        expect((await check(spec, timeFormat, { parameterNames: [] })).diagnostics).toEqual([]);
    });
    test("global schema chains and property refs retain the original example", async () => {
        const spec = document(dialect);
        const schemas = definitions(spec, dialect);
        schemas.Resource = { properties: { created_at: schemaRef(dialect, "Timestamp") } };
        schemas.Alias = schemaRef(dialect, "Resource");
        schemas.Timestamp = { type: "string", example: "bad-timestamp" };
        const { diagnostics, content } = await check(spec, timeFormat, {}, "json");
        expect(diagnostics).toHaveLength(2);
        for (const diagnostic of diagnostics) expect(content.slice(diagnostic.from, diagnostic.to)).toBe('"bad-timestamp"');
    });
    test.each(["#/missing", "external.yaml#/Resource", "#/x-contracts/Loop"])(
        "necessary global schema reference %s fails the selected rule", async (reference) => {
            const spec = document(dialect, { "x-contracts": { Loop: { $ref: "#/x-contracts/Loop" } } });
            definitions(spec, dialect).Resource = { $ref: reference };
            for (const id of [timeFormat, timeName]) await check(spec, id, {}, "yaml", true);
        },
    );
    test.each(["request", "response"] as const)("inline native %s schemas are checked behind Path Item refs", async (kind) => {
        const schema = { properties: { create_time: { type: "string" } } };
        const operation = kind === "request" ? request(dialect, schema)
            : { responses: { "201": response(dialect, schema), "400": response(dialect, schema) } };
        const spec = document(dialect, {
            paths: { "/v1/resources": { $ref: "#/x-path-items/Alias" } },
            "x-path-items": { Alias: { $ref: "#/x-path-items/Resource" }, Resource: { post: operation } },
        });
        const { diagnostics } = await check(spec, timeName);
        expect(diagnostics).toHaveLength(kind === "request" ? 1 : 2);
        expect(diagnostics.every((diagnostic) => diagnostic.message.includes('Found "create_time"'))).toBe(true);
    });
    test("shared schemas and recursive $refs are visited once across operations and global scan", async () => {
        const spec = document(dialect);
        const ref = schemaRef(dialect, "Resource");
        definitions(spec, dialect).Resource = { properties: { create_time: { type: "string" }, child: ref } };
        spec.paths = {
            "/v1/resources": { post: { ...request(dialect, ref), responses: { "200": response(dialect, ref) } } },
            "/v1/other": { get: { responses: { "200": response(dialect, ref) } } },
        };
        expect((await check(spec, timeName)).diagnostics).toHaveLength(1);
    });
    test("iterative schema walking handles a long referenced property chain", async () => {
        const spec = document(dialect);
        const schemas = definitions(spec, dialect);
        for (let index = 0; index < 1500; index++) {
            schemas[`Node${index}`] = { properties: index === 1499
                ? { create_time: { type: "string" } } : { child: schemaRef(dialect, `Node${index + 1}`) } };
        }
        expect((await check(spec, timeName, {}, "json")).diagnostics).toHaveLength(1);
    });
    test("metadata and unrelated parameter schemas are not interpreted as payloads", async () => {
        const spec = document(dialect, { paths: { "/v1/resources": {
            "x-preview": request(dialect, { properties: { create_time: { type: "string" } } }),
            parameters: [{ name: "filter", in: "query", ...(dialect === "swagger2" ? { type: "string" }
                : { schema: { $ref: "unselected.yaml#/Filter" } }) }],
            post: { responses: { "204": { description: "No content" } } },
        } } });
        expect((await check(spec, timeName)).diagnostics).toEqual([]);
    });
    test("real inherited parameter names and recommendation configuration remain effective", async () => {
        const spec = document(dialect, { paths: { "/v1/resources": {
            parameters: [{ name: "create_time", in: "query", ...(dialect === "swagger2" ? { type: "string" }
                : { schema: { type: "string" } }) }],
            get: { parameters: [{ name: "X-Request-Time", in: "header", ...(dialect === "swagger2" ? { type: "string" }
                : { schema: { type: "string" } }) }] },
        } } });
        const { diagnostics } = await check(spec, timeName);
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics.some((diagnostic) => diagnostic.message.includes('Recommended: "created_at"'))).toBe(true);
        expect((await check(spec, timeName, { recommendedNames: ["create_time", "X-Request-Time"] })).diagnostics).toEqual([]);
    });
    test.each(["created_at", "updated_at", "start_time", "end_time", "read_time", "format"])(
        "recommended or non-time field %s remains accepted", async (name) => {
            const spec = document(dialect);
            definitions(spec, dialect).Resource = { properties: { [name]: { type: "string" } } };
            expect((await check(spec, timeName)).diagnostics).toEqual([]);
        },
    );
    test.each([timeFormat, timeName])("%s leaves frozen native declarations and refs untouched", async (id) => {
        const spec = document(dialect);
        definitions(spec, dialect).Resource = { properties: {
            created_at: { example: "not-a-date" }, create_time: { type: "string" },
        } };
        const before = JSON.stringify(spec);
        const pending: unknown[] = [spec];
        for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
            if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
                pending.push(...Object.values(item));
                Object.freeze(item);
            }
        }
        const rule = ruleFor(id);
        expect(await functionsMap[rule.call.function](spec, text(spec, "json"), rule)).toHaveLength(1);
        expect(JSON.stringify(spec)).toBe(before);
    });
});

test("Swagger body container names are excluded but real formData names are checked", async () => {
    const spec = document("swagger2", { paths: { "/v1/resources": { post: {
        parameters: [{ in: "body", name: "createdAt", schema: { properties: { created_at: { type: "string" } } } }],
    } } } });
    expect((await check(spec, timeName)).diagnostics).toEqual([]);
    object(object(object(spec.paths)["/v1/resources"]).post).parameters = [{ in: "formData", name: "create_time", type: "string" }];
    expect((await check(spec, timeName)).diagnostics).toHaveLength(1);
});
test("Swagger effective body override does not revive the superseded path schema", async () => {
    const spec = document("swagger2", { parameters: { SharedBody: { name: "body", in: "body", schema: {
        properties: { create_time: { type: "string" } },
    } } }, paths: { "/v1/resources": {
        parameters: [{ $ref: "#/parameters/SharedBody" }],
        post: request("swagger2", { properties: { created_at: { type: "string" } } }),
    } } });
    expect((await check(spec, timeName)).diagnostics).toEqual([]);
});
test("OpenAPI reusable requestBody/response schemas retain all media and response codes", async () => {
    const spec = document("openapi3", { components: {
        requestBodies: { Body: { content: { "application/json": { schema: { properties: { created_at: {} } } },
            "application/xml": { schema: { properties: { create_time: {} } } } } } },
        responses: { Error: { description: "Error", content: { "application/json": {
            schema: { properties: { updatedAt: {} } },
        } } } },
    }, paths: { "/v1/resources": { post: {
        requestBody: { $ref: "#/components/requestBodies/Body" },
        responses: { "400": { $ref: "#/components/responses/Error" } },
    } } } });
    expect((await check(spec, timeName)).diagnostics).toHaveLength(2);
});
test("OpenAPI without schemas and explicitly malformed native schema containers are distinguished", async () => {
    for (const id of [timeFormat, timeName]) {
        expect((await check(document("openapi3", { components: {} }), id)).diagnostics).toEqual([]);
        await check(document("openapi3", { components: { schemas: null } }), id, {}, "json", true);
        await check(document("swagger2", { definitions: [] }), id, {}, "json", true);
    }
});
test("YAML timestamp Date values retain their existing ISO formatting behavior", async () => {
    const spec = { openapi: "3.0.3", components: { schemas: { Resource: {
        properties: { created_at: { example: new Date("2026-01-01T00:00:00Z") } },
    } } } };
    const rule = ruleFor(timeFormat);
    expect(await functionsMap[rule.call.function](spec, yaml.dump(spec), rule)).toEqual([]);
});
