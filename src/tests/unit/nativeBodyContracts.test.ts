import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { isRecord } from "@/lib/openapi/references";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native body rules must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Native body rules must not convert documents."); }),
}), { virtual: true });

type Doc = Record<string, unknown>;
type Dialect = "swagger2" | "openapi3";
type Format = "yaml" | "json" | "flow";
const formats: Format[] = ["yaml", "json", "flow"];
const request = "COD-030-01-2507-2507-M";
const response = "COD-040-01-2507-2507-M";
const getBody = "STC-010-01-2507-2507-M-3";
const detail = "STC-010-01-2507-2507-M-4";
const list = "STC-010-01-2507-2507-M-5";
const count = "QUE-040-01-2507-2507-M";
const time = "QUE-060-01-2507-2507-M";
const ids = [request, response, getBody, detail, list, count, time];
const rules = new Map<string, AutoRule>();

beforeAll(async () => {
    const paths = ["Request_body", "Response_body", "Request_Verb_And_Response_Status_Code",
        "Requirements_for_query_operations"].map((name) => `${process.cwd()}/public/rulesets/default/${name}.yaml`);
    const catalog = await loadRuleCatalog(paths, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) if (ids.includes(rule.id)) rules.set(rule.id, rule);
    expect(rules.size).toBe(7);
});
beforeEach(() => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native body rules must not access the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function ruleFor(id: string): AutoRule {
    const rule = rules.get(id);
    if (!rule) throw new Error(`Missing rule ${id}`);
    return rule;
}
function object(value: unknown): Doc {
    if (!isRecord(value)) throw new Error("Expected fixture object");
    return value;
}
function document(dialect: Dialect, path: string, method: string, operation: Doc, extra: Doc = {}): Doc {
    return { ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native", version: "v1" }, paths: { [path]: { [method]: operation } }, ...extra };
}
function responseBody(dialect: Dialect, schema: Doc, types = ["application/json"]): Doc {
    return { description: "OK", ...(dialect === "swagger2" ? { schema }
        : { content: Object.fromEntries(types.map((type) => [type, { schema }])) }) };
}
function operation(dialect: Dialect, schema: Doc, types = ["application/json"]): Doc {
    return { responses: { "200": responseBody(dialect, schema, types), "204": { description: "No body" } },
        ...(dialect === "swagger2" ? { produces: types } : {}) };
}
function requestOperation(dialect: Dialect, types = ["application/json"]): Doc {
    return dialect === "swagger2"
        ? { parameters: [{ name: "payload", in: "body", schema: { type: "object" } }], consumes: types, responses: {} }
        : { requestBody: { content: Object.fromEntries(types.map((type) => [type, { schema: { type: "object" } }])) }, responses: {} };
}
function schemaRef(dialect: Dialect, name: string): Doc {
    return { $ref: `#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/${name}` };
}
function definitions(dialect: Dialect, schemas: Doc): Doc {
    return dialect === "swagger2" ? { definitions: schemas } : { components: { schemas } };
}
function wrapper(withCount = true): Doc {
    return { type: "object", properties: {
        items: { type: "array", items: { type: "object" } },
        ...(withCount ? { count: { type: "integer" } } : {}),
    } };
}
async function check(spec: Doc, id: string, params: Doc = {}, format: Format = "yaml") {
    const base = ruleFor(id);
    const rule = { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
    const content = format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) });
    const { diagnostics } = await runLinter(content, [rule]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.source).toContain(id);
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
    }
    return { diagnostics, content };
}

describe.each(["swagger2", "openapi3"] satisfies Dialect[])("%s body contracts", (dialect) => {
    test.each(formats)("%s encapsulation uses native media and supports parameterized declarations", async (format) => {
        const doc = document(dialect, "/items", "post", requestOperation(dialect, ['Application/JSON; charset="UTF-8"']));
        expect((await check(doc, request, {}, format)).diagnostics).toEqual([]);
        const wrong = document(dialect, "/items", "post", requestOperation(dialect, ["text/plain"]));
        expect((await check(wrong, request, {}, format)).diagnostics).toHaveLength(1);
        const op = operation(dialect, { type: "object" });
        object(object(op.responses)["200"]).headers = { "X-Request-Id": {} };
        const output = document(dialect, "/items", "post", op);
        expect((await check(output, response, {}, format)).diagnostics).toEqual([]);
        expect((await check(output, response, { headers: ["Content-Type"] }, format)).diagnostics).toHaveLength(1);
        object(object(op.responses)["200"]).headers = {};
        expect((await check(output, response, { headers: ["Content-Type"] }, format)).diagnostics).toEqual([]);
    });

    test("request media exclusions skip the operation, while response exclusions skip only their response", async () => {
        const op = { ...requestOperation(dialect, ["application/xml; charset=UTF-8"]),
            ...operation(dialect, { type: "object" }, ["text/plain"]) };
        const doc = document(dialect, "/items", "post", op);
        expect((await check(doc, response)).diagnostics).toEqual([]);
        if (dialect === "swagger2") {
            op.parameters = [];
        } else {
            delete op.requestBody;
        }
        expect((await check(doc, response)).diagnostics).toHaveLength(1);
        op.responses = {
            "200": responseBody(dialect, { type: "object" }, ["application/xml; charset=UTF-8"]),
            "201": responseBody(dialect, { type: "object" }, ["text/plain"]),
        };
        if (dialect === "swagger2") {
            // Swagger has one effective produces list for all statuses.
            op.produces = ["application/xml; charset=UTF-8"];
            expect((await check(doc, response)).diagnostics).toEqual([]);
        } else expect((await check(doc, response)).diagnostics).toHaveLength(1);
    });

    test("no-body and unconfigured response methods/statuses are not body errors", async () => {
        const doc = document(dialect, "/items", "post", { responses: { "204": { description: "No body" } } });
        expect((await check(doc, request)).diagnostics).toEqual([]);
        expect((await check(doc, response)).diagnostics).toEqual([]);
        const get = document(dialect, "/items", "get", operation(dialect, { type: "string" }, ["text/plain"]));
        expect((await check(get, response)).diagnostics).toEqual([]);
        const onlyErrors = document(dialect, "/items/{id}", "get", {
            responses: { "400": responseBody(dialect, { type: "string" }) },
        });
        expect((await check(onlyErrors, detail)).diagnostics).toEqual([]);
        expect((await check(onlyErrors, time)).diagnostics).toEqual([]);
    });

    test("request encapsulation remains all-methods while selected query status/method remain configurable", async () => {
        const doc = document(dialect, "/items", "post", requestOperation(dialect, ["text/plain"]));
        expect((await check(doc, request, { methods: ["get"] })).diagnostics).toHaveLength(1);
        const op = { responses: { "201": responseBody(dialect, wrapper(false)) } };
        const created = document(dialect, "/items", "post", op);
        expect((await check(created, count)).diagnostics).toEqual([]);
        expect((await check(created, count, { method: "post", responseCode: 201 })).diagnostics).toHaveLength(1);
        const allSuccess = document(dialect, "/items/{id}", "get", {
            responses: { "201": responseBody(dialect, { type: "string" }), "400": responseBody(dialect, { type: "string" }) },
        });
        expect((await check(allSuccess, detail)).diagnostics).toHaveLength(1);
    });

    test("GET body and action checks keep their scope and one-diagnostic behavior", async () => {
        const doc = document(dialect, "/items", "get", requestOperation(dialect));
        expect((await check(doc, getBody)).diagnostics).toHaveLength(1);
        expect((await check(doc, getBody, { disallowRequestBody: false })).diagnostics).toEqual([]);
        const action = document(dialect, "/items/RESTART", "get", requestOperation(dialect));
        expect((await check(action, getBody)).diagnostics).toHaveLength(1);
        const post = document(dialect, "/items/restart", "post", requestOperation(dialect));
        expect((await check(post, getBody)).diagnostics).toEqual([]);
    });

    test.each(formats)("%s escaped/chained response and schema refs preserve original nodes", async (format) => {
        const extra = definitions(dialect, {
            Alias: schemaRef(dialect, "A~1B"), "A/B": { type: "object" },
        });
        const shared = responseBody(dialect, schemaRef(dialect, "Alias"));
        const responseRef = dialect === "swagger2" ? "#/responses/Shared" : "#/components/responses/Shared";
        if (dialect === "swagger2") extra.responses = { Shared: shared };
        else object(extra.components).responses = { Shared: shared };
        const doc = document(dialect, "/items/{id}", "get", {
            responses: { "200": { $ref: responseRef } },
        }, extra);
        expect((await check(doc, detail, {}, format)).diagnostics).toEqual([]);
        const schemas = dialect === "swagger2" ? object(extra.definitions) : object(object(extra.components).schemas);
        object(schemas["A/B"]).type = "string";
        const { diagnostics, content } = await check(doc, detail, {}, format);
        expect(diagnostics).toHaveLength(1);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe(format === "json" ? '"get"' : "get");
    });

    test.each([
        { type: "array", items: { type: "object" } },
        wrapper(),
        { type: "object", properties: { note: { type: "string" }, page: { type: "integer" },
            resources: { type: "array" } } },
        { type: "object", required: ["resources"], properties: { label: { type: "string" } } },
    ])("retains list wrapper/plural heuristics for %j", async (schema) => {
        expect((await check(document(dialect, "/items", "get", operation(dialect, schema)), list)).diagnostics).toEqual([]);
    });

    test.each(["oneOf", "anyOf"])("%s type and count checks keep their existing variant policies", async (keyword) => {
        const badType = { [keyword]: [{ type: "array" }, { type: "string" }] };
        expect((await check(document(dialect, "/items", "get", operation(dialect, badType)), list)).diagnostics).toHaveLength(1);
        const nonListVariant = { type: "object", properties: { note: { type: "string" } } };
        const mixed = { [keyword]: [wrapper(), nonListVariant] };
        expect((await check(document(dialect, "/items", "get", operation(dialect, mixed)), count)).diagnostics).toEqual([]);
        mixed[keyword] = [wrapper(), wrapper(false)];
        expect((await check(document(dialect, "/items", "get", operation(dialect, mixed)), count)).diagnostics).toHaveLength(1);
        const bare = { [keyword]: [wrapper(), { type: "array" }] };
        expect((await check(document(dialect, "/items", "get", operation(dialect, bare)), count)).diagnostics).toHaveLength(1);
        const plural = { [keyword]: [{ type: "object", required: ["resources"], properties: {} }] };
        expect((await check(document(dialect, "/items", "get", operation(dialect, plural)), list)).diagnostics).toHaveLength(1);
    });

    test("count presence/type, disallowed aliases and optional policy are preserved", async () => {
        const schema = wrapper();
        const doc = document(dialect, "/items", "get", operation(dialect, schema));
        expect((await check(doc, count)).diagnostics).toEqual([]);
        expect(schema).not.toHaveProperty("required");
        object(object(schema.properties).count).type = "string";
        expect((await check(doc, count)).diagnostics).toHaveLength(1);
        expect((await check(doc, count, { required: false })).diagnostics).toEqual([]);
        object(schema.properties).total_count = { type: "integer" };
        expect((await check(doc, count, { required: false })).diagnostics).toHaveLength(1);
        const noArray = document(dialect, "/items", "get", operation(dialect, { type: "object", properties: {} }));
        expect((await check(noArray, count)).diagnostics).toEqual([]);
    });

    test("unknown MIME still permits structural schema checks without assuming JSON", async () => {
        const op = operation(dialect, wrapper(false), dialect === "swagger2" ? [] : ["application/xml"]);
        const doc = document(dialect, "/items", "get", op);
        expect((await check(doc, count)).diagnostics).toHaveLength(1);
        expect((await check(doc, list)).diagnostics).toEqual([]);
    });

    test("time fields traverse recursive properties, arrays, composition and maps without changing presence policy", async () => {
        const schema = { type: "object", properties: { next: schemaRef(dialect, "Node") },
            allOf: [{ additionalProperties: { properties: { created_at: { type: "string" } } } }],
            anyOf: [{ items: { properties: { updated_at: { type: "string" } } } }] };
        const doc = document(dialect, "/items/{resource_id}", "get",
            operation(dialect, schemaRef(dialect, "Node")), definitions(dialect, { Node: schema }));
        expect((await check(doc, time)).diagnostics).toEqual([]);
        schema.anyOf = [];
        expect((await check(doc, time)).diagnostics).toHaveLength(1);
    });

    test("path filters precede Path Item refs, including tag/project/status exclusions", async () => {
        for (const path of ["/items/{project_id}", "/items/{id}/tags", "/items/tags/{id}"]) {
            const doc = document(dialect, "/unused", "get", {});
            doc.paths = { [path]: { $ref: "#/missing" } };
            expect((await check(doc, time)).diagnostics).toEqual([]);
        }
        const doc = document(dialect, "/unused", "get", {});
        doc.paths = { "/status": { $ref: "#/missing" } };
        expect((await check(doc, list)).diagnostics).toEqual([]);
        doc.paths = { "/items/{id}": { $ref: "#/missing" } };
        expect((await check(doc, count, { pathMustNotContainPathParams: true })).diagnostics).toEqual([]);
        expect((await check(doc, detail)).diagnostics[0].message).toContain("execution failed");
    });

    test.each(["#/missing", "other.yaml#/Schema", "#/x-cycle"])("selected ref %s cannot become PASS", async (ref) => {
        const doc = document(dialect, "/items/{id}", "get", operation(dialect, { $ref: ref }),
            { "x-cycle": { $ref: "#/x-cycle" } });
        for (const id of [detail, count, time]) {
            const { diagnostics } = await check(doc, id);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("execution failed");
        }
    });

    test("invalid plural-required fallback fails at the original referenced field", async () => {
        const doc = document(dialect, "/items", "get", operation(dialect, schemaRef(dialect, "List")),
            definitions(dialect, { List: { type: "object", required: [1, "resources"], properties: {} } }));
        const { diagnostics, content } = await check(doc, list, {}, "json");
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("execution failed");
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe('"required"');
    });

    test("direct consumers preserve frozen original documents and schemas", async () => {
        const op = { ...requestOperation(dialect), ...operation(dialect, wrapper()) };
        const doc = document(dialect, "/items/{id}", "get", op);
        const freeze = (value: unknown): void => {
            if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        };
        freeze(doc);
        const content = yaml.dump(doc);
        for (const id of ids) {
            const rule = ruleFor(id);
            const before = JSON.stringify(doc);
            await functionsMap[rule.call.function](doc, content, rule);
            expect(JSON.stringify(doc)).toBe(before);
            expect(object(object(doc.paths)["/items/{id}"]).get).toBe(op);
        }
    });

    test("long property-reference chains do not overflow the time-field traversal", async () => {
        const schemas: Doc = {};
        for (let index = 0; index < 1500; index++) {
            schemas[`Node${index}`] = { type: "object", properties: index === 1499
                ? { created_at: { type: "string" }, updated_at: { type: "string" } }
                : { next: schemaRef(dialect, `Node${index + 1}`) } };
        }
        const doc = document(dialect, "/items/{id}", "get",
            operation(dialect, schemaRef(dialect, "Node0")), definitions(dialect, schemas));
        expect((await check(doc, time, {}, "json")).diagnostics).toEqual([]);
    });
});

test.each([detail, list, count, time])("OAS3 body without schema fails %s; no-body responses do not", async (id) => {
    const path = id === detail || id === time ? "/items/{id}" : "/items";
    const op = { responses: { "200": { description: "OK", content: { "application/json": {} } } } };
    const doc = document("openapi3", path, "get", op);
    expect((await check(doc, id)).diagnostics).toHaveLength(1);
    delete object(op.responses["200"]).content;
    expect((await check(doc, id)).diagnostics).toEqual([]);
});

test.each([count, time])("exact JSON preference and unselected media refs are preserved for %s", async (id) => {
    const schema = id === count ? wrapper() : { type: "object", properties: {
        create_time: { type: "string" }, update_time: { type: "string" },
    } };
    const path = id === count ? "/items" : "/items/{id}";
    const doc = document("openapi3", path, "get", { responses: { "200": { description: "OK", content: {
        "application/xml": { schema: { $ref: "#/missing" } }, "application/json": { schema },
    } } } });
    expect((await check(doc, id)).diagnostics).toEqual([]);
    expect((await check(doc, id === count ? list : detail)).diagnostics[0].message).toContain("execution failed");
});

test("native GET inherited body/formData and referenced requestBody declarations are not skipped", async () => {
    for (const location of ["body", "formData"]) {
        const param = location === "body" ? { name: "payload", in: "body", schema: { type: "object" } }
            : { name: "file", in: "formData", type: "file" };
        const doc = document("swagger2", "/items", "get", { responses: {} }, { parameters: { Body: param } });
        object(object(doc.paths)["/items"]).parameters = [{ $ref: "#/parameters/Body" }];
        expect((await check(doc, getBody)).diagnostics).toHaveLength(1);
    }
    const doc = document("openapi3", "/items", "get", {
        requestBody: { $ref: "#/components/requestBodies/Body" }, responses: {},
    }, { components: { requestBodies: { Body: { content: { "application/json": {} } } } } });
    expect((await check(doc, getBody)).diagnostics).toHaveLength(1);
});

test("unknown Swagger MIME with a body fails encapsulation without inventing JSON", async () => {
    const op = requestOperation("swagger2", []);
    Object.assign(op, operation("swagger2", { type: "object" }, []));
    const doc = document("swagger2", "/items", "post", op);
    expect((await check(doc, request)).diagnostics).toHaveLength(1);
    expect((await check(doc, response)).diagnostics).toHaveLength(1);
});

test("legacy non-standard body selectors remain literal", async () => {
    const op = { "x-body": { content: { "application/json": {} } },
        "x-output": { "200": { content: { "application/json": {} } } } };
    const doc = document("openapi3", "/items", "post", op);
    const content = yaml.dump(doc);
    for (const [id, element] of [[request, "x-body"], [response, "x-output"]]) {
        const base = ruleFor(id);
        const diagnostics = await functionsMap[base.call.function](doc, content, { ...base, element });
        expect(diagnostics).toEqual([]);
    }
});

test.each([detail, list, count])("malformed selected oneOf is explicit for %s", async (id) => {
    const path = id === detail ? "/items/{id}" : "/items";
    const doc = document("openapi3", path, "get", operation("openapi3", { oneOf: [] }));
    const { diagnostics } = await check(doc, id);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("execution failed");
});
