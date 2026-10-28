import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { isRecord } from "@/lib/openapi/references";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native naming must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Native naming must not convert documents."); }),
}), { virtual: true });

type Doc = Record<string, unknown>;
type Dialect = "swagger2" | "openapi3";
type Format = "yaml" | "json" | "flow";
const formats: Format[] = ["yaml", "json", "flow"];
const common = "COM-010-01-2507-2509-M";
const naming = "ARG-010-01-2507-2509-M";
const scope = "ARG-040-01-2507-2507-O";
const redundant = "ARG-050-01-2507-2507-O";
const root = "ARG-060-01-2507-2507-O";
const rules = new Map<string, AutoRule>();
const bodyCases = [
    { id: common, good: "count", bad: "total_count", field: { type: "integer" } },
    { id: naming, good: "display_name", bad: "displayName", field: { type: "string" } },
    { id: redundant, good: "active_filter", bad: "future_filter", field: { type: "string" } },
    { id: root, good: "users", bad: "user", field: { type: "array", items: { type: "object" } } },
];

beforeAll(async () => {
    const paths = ["Common_Parameter_Design", "Request _And_Response_Parameter_Formats"]
        .map((name) => `${process.cwd()}/public/rulesets/default/${name}.yaml`);
    const catalog = await loadRuleCatalog(paths, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.id, rule);
    expect(rules.size).toBe(5);
});
beforeEach(() => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native naming must not access the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function object(value: unknown): Doc {
    if (!isRecord(value)) throw new Error("Expected a fixture object");
    return value;
}
function document(dialect: Dialect, operation: Doc, method = "get", path = "/v1/users", pathItem: Doc = {}, extra: Doc = {}): Doc {
    return {
        ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native naming", version: "v1" }, paths: { [path]: { ...pathItem, [method]: operation } }, ...extra,
    };
}
function response(dialect: Dialect, schema?: Doc): Doc {
    return { description: "OK", ...(schema ? dialect === "swagger2" ? { schema }
        : { content: { "application/json": { schema } } } : {}) };
}
function request(dialect: Dialect, schema?: Doc, container = "RequestBody"): Doc {
    return dialect === "swagger2"
        ? { parameters: [{ name: container, in: "body", ...(schema ? { schema } : {}) }], responses: {} }
        : { requestBody: { content: { "application/json": { ...(schema ? { schema } : {}) } } }, responses: {} };
}
function parameter(dialect: Dialect, name: string, location = "query", extra: Doc = {}): Doc {
    return { name, in: location, ...(dialect === "swagger2" ? { type: "string" } : { schema: { type: "string" } }), ...extra };
}
function definitions(dialect: Dialect, schemas: Doc): Doc {
    return dialect === "swagger2" ? { definitions: schemas } : { components: { schemas } };
}
function reference(dialect: Dialect, name: string): Doc {
    return { $ref: `#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/${name}` };
}
async function check(doc: Doc, id: string, params: Doc = {}, format: Format = "yaml") {
    const base = rules.get(id);
    if (!base) throw new Error(`Missing rule ${id}`);
    const rule = { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
    const content = format === "json" ? JSON.stringify(doc)
        : yaml.dump(doc, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) });
    const { diagnostics } = await runLinter(content, [rule]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.source).toContain(id);
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
    }
    return { diagnostics, content };
}

describe.each(["swagger2", "openapi3"] satisfies Dialect[])("%s naming contracts", (dialect) => {
    test.each(formats)("%s body properties work through escaped/chained schema references", async (format) => {
        for (const entry of bodyCases) {
            for (const valid of [true, false]) {
                const name = valid ? entry.good : entry.bad;
                const schema = { type: "object", properties: { [name]: entry.field } };
                const doc = document(dialect, { responses: { "200": response(dialect, reference(dialect, "Alias")) } },
                    "get", "/v1/users", {}, definitions(dialect, {
                        Alias: reference(dialect, "Shared~1value~0node"), "Shared/value~node": schema,
                    }));
                const result = await check(doc, entry.id, {}, format);
                expect(result.diagnostics).toHaveLength(valid ? 0 : 1);
                if (!valid && entry.id === naming) {
                    expect(result.content.slice(result.diagnostics[0].from, result.diagnostics[0].to)).toContain(name);
                }
            }
        }
    });

    test.each(formats)("%s request body properties do not confuse body containers with payload names", async (format) => {
        for (const entry of bodyCases) {
            const good = entry.id === root ? "user" : entry.good;
            const bad = entry.id === root ? "users" : entry.bad;
            for (const valid of [true, false]) {
                const schema = { type: "object", properties: { [valid ? good : bad]: entry.field } };
                const doc = document(dialect, request(dialect, schema, entry.id === common ? "descp" : "RequestBody"), "post");
                expect((await check(doc, entry.id, {}, format)).diagnostics).toHaveLength(valid ? 0 : 1);
            }
        }
    });

    test("uses effective project_id and preserves global/regional policies", async () => {
        for (const tag of ["global", "regional"]) {
            for (const valid of [true, false]) {
                const required = tag === "regional" ? valid : !valid;
                const doc = document(dialect, {
                    tags: [tag], parameters: [parameter(dialect, "project_id", "path", { required })],
                }, "get", "/v1/{project_id}/users", {
                    parameters: [parameter(dialect, "project_id", "path", { required: !required })],
                });
                expect((await check(doc, scope)).diagnostics).toHaveLength(valid ? 0 : 1);
            }
        }
        expect((await check(document(dialect, {}), scope)).diagnostics).toHaveLength(1);
        expect((await check(document(dialect, {}), scope, { failWhenScopeTagMissing: false })).diagnostics).toEqual([]);
        expect((await check(document(dialect, { tags: ["global", "regional"] }), scope)).diagnostics).toHaveLength(1);
    });

    test("legal overrides are not duplicates, but repeated same-list names remain violations", async () => {
        const value = parameter(dialect, "limit");
        const overridden = document(dialect, { parameters: [value] }, "get", "/v1/users", { parameters: [value] });
        expect((await check(overridden, redundant)).diagnostics).toEqual([]);
        const repeated = document(dialect, { parameters: [value, value] });
        expect((await check(repeated, redundant)).diagnostics).toHaveLength(1);
        expect((await check(repeated, redundant, { checkDuplicateNamesWithinSameContainer: false })).diagnostics).toEqual([]);
        const shadowedDuplicates = document(dialect, { parameters: [value] }, "get", "/v1/users", { parameters: [value, value] });
        expect((await check(shadowedDuplicates, redundant)).diagnostics).toHaveLength(1);
        const separate = document(dialect, { parameters: [parameter(dialect, "id", "query"), parameter(dialect, "id", "header")] });
        expect((await check(separate, redundant)).diagnostics).toEqual([]);
        expect((await check(separate, redundant, { compareScopesSeparately: false })).diagnostics).toHaveLength(1);
    });

    test("reserved descriptions, similarity thresholds and top-level-only scope are unchanged", async () => {
        const schema = { type: "object", properties: { future_filter: { type: "string", "x-reserved": true } } };
        const doc = document(dialect, request(dialect, schema), "post");
        expect((await check(doc, redundant)).diagnostics).toHaveLength(1);
        expect((await check(doc, redundant, { reservedDescriptionRequired: false })).diagnostics).toEqual([]);
        object(object(schema.properties).future_filter).description = "Reserved for future use.";
        expect((await check(doc, redundant)).diagnostics).toEqual([]);
        const nested = { type: "object", properties: { profile: schema } };
        expect((await check(document(dialect, request(dialect, nested), "post"), redundant)).diagnostics).toEqual([]);
        const similar = { type: "object", properties: {
            limit: { description: "Maximum number of resources returned in one response page." },
            page_size: { description: "Maximum number of resources returned in one response page today." },
        } };
        const pair = document(dialect, request(dialect, similar), "post");
        expect((await check(pair, redundant)).diagnostics).toHaveLength(1);
        expect((await check(pair, redundant, { minDescriptionSimilarityThreshold: 1 })).diagnostics).toEqual([]);
    });

    test("no-body and schema-less bodies retain skips instead of new parser errors", async () => {
        for (const id of [common, naming, redundant, root]) {
            expect((await check(document(dialect, { responses: { "204": response(dialect) } }), id)).diagnostics).toEqual([]);
            expect((await check(document(dialect, request(dialect), "post"), id)).diagnostics).toEqual([]);
        }
    });

    test("ordinary recursive schemas terminate and literal property names are preserved", async () => {
        for (const name of ["profile.user_name", "items[]", "a/b~c", "displayName"]) {
            const schema = { type: "object", properties: {
                [name]: { type: "string" }, child: reference(dialect, "Recursive"),
            } };
            const doc = document(dialect, { responses: { "200": response(dialect, reference(dialect, "Recursive")) } },
                "get", "/v1/users", {}, definitions(dialect, { Recursive: schema }));
            const { diagnostics, content } = await check(doc, naming);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain(name);
            expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toContain(name);
        }
    });

    test("nested schema examples are inspected without treating values as schemas", async () => {
        const schema = { type: "object", properties: {
            profile: { type: "object", example: { total_count: 1 }, properties: { name: { type: "string" } } },
        } };
        const doc = document(dialect, request(dialect, schema), "post");
        expect((await check(doc, common)).diagnostics).toHaveLength(1);
        const plainData = { type: "object", example: { $ref: "this is payload data", name: "value" } };
        expect((await check(document(dialect, request(dialect, plainData), "post"), common)).diagnostics).toEqual([]);
    });

    test("necessary broken references fail the selected rule, never the parser", async () => {
        for (const id of [common, naming, redundant, root]) {
            const doc = document(dialect, { responses: { "200": response(dialect, reference(dialect, "Missing")) } });
            const { diagnostics } = await check(doc, id);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("execution failed");
        }
        const doc = document(dialect, { tags: ["regional"], parameters: [{ $ref: "#/missing" }] });
        expect((await check(doc, scope)).diagnostics[0].message).toContain("execution failed");
    });
});

test("formData follows request-body toggles and all four native field policies", async () => {
    const form = (name: string, extra: Doc = {}) => document("swagger2", {
        parameters: [parameter("swagger2", name, "formData", extra)], responses: {},
    }, "post");
    expect((await check(form("displayName"), naming, { checkRequestParameters: false })).diagnostics).toHaveLength(1);
    expect((await check(form("displayName"), naming, { checkRequestBodyFields: false })).diagnostics).toEqual([]);
    expect((await check(form("descp"), common)).diagnostics).toHaveLength(1);
    expect((await check(form("name"), common)).diagnostics).toEqual([]);
    expect((await check(form("future_filter"), redundant)).diagnostics).toHaveLength(1);
    expect((await check(form("future_filter", { description: "Reserved.", "x-reserved": true }), redundant)).diagnostics).toEqual([]);
    expect((await check(form("user"), root)).diagnostics).toEqual([]);
    expect((await check(form("users"), root)).diagnostics).toHaveLength(1);
});

test.each(bodyCases)("reusable OpenAPI requestBody is checked by $id", async ({ id, bad, field }) => {
    const schema = { type: "object", properties: { [bad === "user" ? "users" : bad]: field } };
    const body = { content: { "application/json": { schema } } };
    const doc = document("openapi3", { requestBody: { $ref: "#/components/requestBodies/Shared" } },
        "post", "/v1/users", {}, { components: { requestBodies: { Shared: body } } });
    expect((await check(doc, id)).diagnostics).toHaveLength(1);
});

test.each(bodyCases)("$id preserves media selection and does not resolve unnecessary schemas", async ({ id, good, bad, field }) => {
    const content: Doc = {
        "application/xml": { schema: { type: "object", properties: { [bad]: field } } },
        "application/json": { schema: { type: "object", properties: { [good]: field } } },
    };
    const output = { description: "OK", content };
    const doc = document("openapi3", { responses: { "200": output } });
    expect((await check(doc, id)).diagnostics).toHaveLength(id === common ? 1 : 0);
    content["application/xml"] = { schema: { $ref: "#/missing" } };
    const findings = (await check(doc, id)).diagnostics;
    expect(findings).toHaveLength(id === common ? 1 : 0);
    if (id === common) expect(findings[0].message).toContain("execution failed");
});

test("common names inspect explicit and schema examples, resolving Example Objects but not external payloads", async () => {
    const schema = { type: "object", example: { total_count: 1 }, properties: { name: { type: "string" } } };
    const media: Doc = { schema, example: { name: "valid explicit example" } };
    const doc = document("openapi3", { requestBody: { content: { "application/json": media } } }, "post");
    expect((await check(doc, common)).diagnostics).toHaveLength(1);
    delete media.schema;
    delete media.example;
    media.examples = { Bad: { $ref: "#/components/examples/Bad" } };
    doc.components = { examples: { Bad: { value: { total_count: 1 } } } };
    const { diagnostics, content } = await check(doc, common);
    expect(diagnostics).toHaveLength(1);
    expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("total_count");
    media.examples = { Bad: { externalValue: "https://example.invalid/payload" } };
    expect((await check(doc, common)).diagnostics[0].message).toContain("External example payloads");
    const v2 = document("swagger2", { responses: { "200": { description: "OK", examples: {
        "application/json": { total_count: 1 },
    } } } });
    expect((await check(v2, common)).diagnostics).toHaveLength(1);
});

test("root names preserve wrapper, status and method policies without composition inference", async () => {
    const output = { type: "object", properties: { items: { type: "array", items: { type: "object" } }, count: { type: "integer" } } };
    expect((await check(document("openapi3", { responses: { "200": response("openapi3", output) } }), root)).diagnostics).toEqual([]);
    const wrong = { type: "object", properties: { user: { type: "object" } } };
    expect((await check(document("openapi3", { responses: { "400": response("openapi3", wrong) } }), root)).diagnostics).toEqual([]);
    expect((await check(document("openapi3", { responses: { "200": response("openapi3", wrong) } }, "delete"), root)).diagnostics).toEqual([]);
    const composed = { allOf: [wrong] };
    expect((await check(document("openapi3", { responses: { "200": response("openapi3", composed) } }), root)).diagnostics).toEqual([]);
});

test("native naming reads frozen documents without rewriting or mutating schema graphs", async () => {
    const schema = { type: "object", properties: { displayName: { type: "string" } } };
    const doc = document("swagger2", request("swagger2", schema), "post");
    const freeze = (value: unknown) => {
        if (value && typeof value === "object" && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const child of Object.values(value)) freeze(child);
        }
    };
    freeze(doc);
    const before = JSON.stringify(doc);
    const rule = rules.get(naming);
    if (!rule) throw new Error("Missing naming rule");
    const direct = await functionsMap.checkParameterIsSnakeCase(doc, before, rule);
    expect(direct).toHaveLength(1);
    expect(JSON.stringify(doc)).toBe(before);
});

test.each(["swagger2", "openapi3"] satisfies Dialect[])("%s retains distinct composition/map traversal policies and resolves reused responses", async (dialect) => {
    const schemas = { Shared: { allOf: [{ type: "object", properties: {
        displayName: { type: "string" },
    } }], additionalProperties: { type: "object", properties: {
        total_count: { type: "integer" },
    } } } };
    const shared = response(dialect, reference(dialect, "Shared"));
    const extra = dialect === "swagger2" ? { definitions: schemas, responses: { Shared: shared } }
        : { components: { schemas, responses: { Shared: shared } } };
    const doc = document(dialect, { responses: { "200": {
        $ref: `#/${dialect === "swagger2" ? "responses" : "components/responses"}/Shared`,
    } } }, "get", "/v1/users", {}, extra);
    expect((await check(doc, naming)).diagnostics).toHaveLength(1);
    expect((await check(doc, common)).diagnostics).toHaveLength(1);
    expect((await check(doc, redundant)).diagnostics).toEqual([]);
    expect((await check(doc, root)).diagnostics).toEqual([]);
});

test.each(["swagger2", "openapi3"] satisfies Dialect[])("%s uses local parameter references without losing same-list duplicate detection", async (dialect) => {
    const shared = parameter(dialect, "project_id", "path", { required: false });
    const reference = { $ref: `#/${dialect === "swagger2" ? "parameters" : "components/parameters"}/Shared` };
    const extra = dialect === "swagger2" ? { parameters: { Shared: shared } } : { components: { parameters: { Shared: shared } } };
    const doc = document(dialect, { tags: ["global"], parameters: [reference] }, "get", "/v1/{project_id}/users", {
        parameters: [parameter(dialect, "project_id", "path", { required: true })],
    }, extra);
    expect((await check(doc, scope)).diagnostics).toEqual([]);
    expect((await check(doc, redundant)).diagnostics).toEqual([]);
    object(object(doc.paths)["/v1/{project_id}/users"]).get = { tags: ["global"], parameters: [reference, reference] };
    expect((await check(doc, redundant)).diagnostics).toHaveLength(1);
});

test.each(["swagger2", "openapi3"] satisfies Dialect[])("%s naming and schema-example discovery survive 1500 property-reference levels", async (dialect) => {
    const schemas: Doc = {};
    for (let index = 0; index < 1500; index++) {
        schemas[`Node${index}`] = { type: "object", properties: { child: reference(dialect, `Node${index + 1}`) } };
    }
    schemas.Node1500 = { type: "object", properties: { displayName: { type: "string" } }, example: { total_count: 1 } };
    const doc = document(dialect, request(dialect, reference(dialect, "Node0")), "post", "/v1/users", {}, definitions(dialect, schemas));
    expect((await check(doc, naming, {}, "json")).diagnostics).toHaveLength(1);
    expect((await check(doc, common, {}, "json")).diagnostics).toHaveLength(1);
});

test("common naming ignores Example Object metadata and does not mistake payload strings for field names", async () => {
    const doc = document("openapi3", { requestBody: { content: { "application/json": { examples: { Shared: {
        summary: "total_count", description: "descp", "x-metadata": { total_count: 1 }, value: { name: "total_count" },
    } } } } } }, "post");
    expect((await check(doc, common)).diagnostics).toEqual([]);
});
