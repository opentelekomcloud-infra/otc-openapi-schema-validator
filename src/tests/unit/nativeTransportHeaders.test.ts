import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { isRecord } from "@/lib/openapi/references";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import { parseDeclaredMediaType } from "@/utils/mediaType";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native rules must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Native rules must not convert documents."); }),
}));

type Dialect = "swagger2" | "openapi3";
type Doc = Record<string, unknown>;
const rules = new Map<string, AutoRule>();
const auth = "BAS-100-01-2507-2507-M-1";
const sensitive = "BAS-100-01-2507-2507-M";
const allowed = "BAS-100-01-2507-2507-M-2";
const https = "COD-010-01-2507-2507-M";
const requestMime = "HDR-010-01-2507-2507-M-1";
const responseMime = "HDR-020-01-2507-2507-M-1";
const bodyMime = "COD-020-01-2507-2507-M";
const getMime = "COD-020-01-2507-2507-M-1";
const requestId = "HDR-020-01-2507-2507-M-2";
const custom = "HDR-020-01-2507-2507-M-3";
const presenceIds = [auth, "BAS-090-01-2507-2507-M",
    ...[2, 3, 4, 5, 6, 7, 8].map((n) => `HDR-010-01-2507-2507-M-${n}`)];

beforeAll(async () => {
    const files = ["Security", "Flow_Control", "Request_Header_Formats",
        "Response_Header_Formats", "HTTPS_protocol", "Content_Type"]
        .map((name) => `${process.cwd()}/public/rulesets/default/${name}.yaml`);
    const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.id, rule);
    expect(rules.size).toBe(18);
});

beforeEach(() => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native rules must not access the network."));
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
    if (!isRecord(value)) throw new Error("Expected a fixture object");
    return value;
}
function document(dialect: Dialect, item: Doc, extra: Doc = {}): Doc {
    return { ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native", version: "v1" }, paths: { "/items": item }, ...extra };
}
function parameter(dialect: Dialect, name: string, type = "string", location = "header"): Doc {
    return { name, in: location, ...(dialect === "swagger2" ? { type } : { schema: { type } }) };
}
function response(dialect: Dialect, types = ["application/json"]): Doc {
    return { description: "OK", ...(dialect === "swagger2" ? { schema: { type: "object" } }
        : { content: Object.fromEntries(types.map((type) => [type, { schema: { type: "object" } }])) }) };
}
function bodyOperation(dialect: Dialect, requestTypes = ["application/json"], responseTypes = ["application/json"]): Doc {
    return {
        ...(dialect === "swagger2" ? {
            parameters: [{ name: "payload", in: "body", schema: { type: "object" } }],
            consumes: requestTypes, produces: responseTypes,
        } : { requestBody: { content: Object.fromEntries(requestTypes.map((type) => [type, { schema: { type: "object" } }])) } }),
        responses: { "200": response(dialect, responseTypes), "204": { description: "No body" } },
    };
}
async function check(spec: Doc, id: string, params?: Doc, format: "yaml" | "json" | "flow" = "yaml") {
    const base = ruleFor(id);
    const rule = params ? { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } } : base;
    const content = format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) });
    const before = JSON.stringify(spec);
    const { diagnostics } = await runLinter(content, [rule]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.source).toContain(id);
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
    }
    expect(JSON.stringify(spec)).toBe(before);
    return { diagnostics, content };
}

describe.each(["swagger2", "openapi3"] satisfies Dialect[])("%s native header rules", (dialect) => {
    test.each(presenceIds)("%s uses inherited headers and conditional triggers without treating parameters as a method", async (id) => {
        const params = ruleFor(id).call.functionParams ?? {};
        const expected = params.headers;
        const triggers = params.checkOnlyIfHeaderExist ?? [];
        if (!Array.isArray(expected) || !Array.isArray(triggers)) throw new Error("Invalid fixture config");
        const names = [...expected, ...triggers].map((entry: unknown) => {
            const name = object(entry).name;
            if (typeof name !== "string") throw new Error("Invalid fixture header name");
            return name;
        });
        const item = { parameters: names.map((name) => parameter(dialect, name)), get: { responses: {} } };
        expect((await check(document(dialect, item), id)).diagnostics).toEqual([]);
        const required = expected.map((entry: unknown) => object(entry).name);
        item.parameters = names.filter((name) => !required.includes(name)).map((name) => parameter(dialect, name));
        const { diagnostics, content } = await check(document(dialect, item), id);
        expect(diagnostics).toHaveLength(1);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("get");
    });

    test("operation headers override the same inherited name/location and preserve type constraints", async () => {
        const item = { parameters: [parameter(dialect, "X-Auth-Token")],
            get: { parameters: [parameter(dialect, "X-Auth-Token", "integer")], responses: {} } };
        expect((await check(document(dialect, item), auth)).diagnostics).toHaveLength(1);
        item.get.parameters = [parameter(dialect, "X-Auth-Token")];
        expect((await check(document(dialect, item), auth)).diagnostics).toEqual([]);
    });

    test("fallback Date and conditional AND use native inherited parameters", async () => {
        const item = { parameters: [parameter(dialect, "Authorization"), parameter(dialect, "Date")],
            get: { responses: {} } };
        expect((await check(document(dialect, item), "HDR-010-01-2507-2507-M-2")).diagnostics).toEqual([]);
        const project = "HDR-010-01-2507-2507-M-6";
        expect((await check(document(dialect, item), project)).diagnostics).toEqual([]);
        item.parameters.push(parameter(dialect, "x-projectScenario"));
        expect((await check(document(dialect, item), project)).diagnostics).toHaveLength(1);
    });

    test("discovery exceptions and custom method filters remain effective", async () => {
        const doc = document(dialect, {});
        doc.paths = { "/": { get: { responses: {} } }, "/items": { post: { responses: {} } } };
        expect((await check(doc, auth, { methods: ["get"] })).diagnostics).toEqual([]);
    });

    test("GET header absence is gated by actual request body, not global MIME declarations", async () => {
        const item = { parameters: [parameter(dialect, "Content-Type")], get: { responses: {} } };
        const doc = document(dialect, item, { consumes: ["application/json"] });
        expect((await check(doc, getMime)).diagnostics).toHaveLength(1);
        Object.assign(item.get, bodyOperation(dialect));
        expect((await check(doc, getMime)).diagnostics).toEqual([]);
        item.parameters = [];
        expect((await check(doc, getMime)).diagnostics).toEqual([]);
    });

    test.each(["path", "query"])("sensitive %s names are found regardless of type, not in headers", async (location) => {
        const item = { parameters: [parameter(dialect, "password", "integer", location)], get: { responses: {} } };
        const doc = document(dialect, item);
        const { diagnostics, content } = await check(doc, sensitive);
        expect(diagnostics).toHaveLength(1);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("password");
        expect((await check(doc, sensitive, { valueType: "string" })).diagnostics).toEqual([]);
        item.parameters = [parameter(dialect, "password", "string", "header")];
        expect((await check(doc, sensitive)).diagnostics).toEqual([]);
    });

    test.each(["parameters", "servers", "summary", "description", "x-note"])("metadata %s is not an HTTP method", async (key) => {
        const doc = document(dialect, { [key]: key === "parameters" ? [] : {}, get: { responses: {} } });
        expect((await check(doc, allowed)).diagnostics).toEqual([]);
        object(object(doc.paths)["/items"]).trace = { responses: {} };
        expect((await check(doc, allowed)).diagnostics).toHaveLength(1);
    });

    test("local parameter and Path Item refs preserve matching, source and errors", async () => {
        const doc = document(dialect, { $ref: "#/x-item" }, {
            "x-param": parameter(dialect, "password", "integer", "query"),
            "x-item": { parameters: [{ $ref: "#/x-param" }], get: { responses: {} } },
        });
        const { diagnostics, content } = await check(doc, sensitive, undefined, "json");
        expect(diagnostics).toHaveLength(1);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe('"password"');
        object(doc["x-item"]).parameters = [{ $ref: "#/missing" }];
        expect((await check(doc, sensitive)).diagnostics[0].message).toContain("execution failed");
    });

    test("reusable response body gates and header names use original declarations", async () => {
        const prefix = dialect === "swagger2" ? "responses" : "components/responses";
        const shared = response(dialect);
        const doc = document(dialect, { get: { responses: { "200": { $ref: `#/${prefix}/Shared` } } } },
            dialect === "swagger2" ? { responses: { Shared: shared } } : { components: { responses: { Shared: shared } } });
        const { diagnostics, content } = await check(doc, requestId);
        expect(diagnostics).toHaveLength(1);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("Shared");
        shared.headers = { "x-obs-request-id": {} };
        expect((await check(doc, requestId)).diagnostics).toEqual([]);
        shared.headers = { Bad_Header: {} };
        expect((await check(doc, custom)).diagnostics).toHaveLength(1);
        delete shared.schema;
        delete shared.content;
        expect((await check(doc, requestId)).diagnostics).toEqual([]);
        expect((await check(doc, custom)).diagnostics).toHaveLength(1);
    });

    test("custom response trigger remains literal instead of being reinterpreted as a body", async () => {
        const shared: Doc = { description: "OK", "x-trigger": { enabled: true } };
        const doc = document(dialect, { get: { responses: { "200": shared } } });
        expect((await check(doc, requestId)).diagnostics).toEqual([]);
        expect((await check(doc, requestId, { ifPropertyExists: "x-trigger" })).diagnostics).toHaveLength(1);
    });

    test("header constraints and literal legacy section gates remain configurable", async () => {
        const header = { ...parameter(dialect, "Authorization"), required: true, description: "Signature", style: "simple" };
        const op: Doc = { parameters: [header], "x-condition": {}, responses: {} };
        const doc = document(dialect, { get: op });
        const params = { headers: [{ name: "Authorization", in: "header", valueType: "string",
            required: true, description: true, style: "simple" }], checkMethodIfSectionExist: "x-condition" };
        expect((await check(doc, auth, params)).diagnostics).toEqual([]);
        header.required = false;
        expect((await check(doc, auth, params)).diagnostics).toHaveLength(1);
        delete op["x-condition"];
        expect((await check(doc, auth, params)).diagnostics).toEqual([]);
    });

    test.each([null, {}, [{ name: "Authorization" }]])("malformed required parameters %j fail explicitly", async (parameters) => {
        const doc = document(dialect, { get: { parameters, responses: {} } });
        for (const id of [auth, sensitive, "HDR-010-01-2507-2507-M-6"]) {
            const { diagnostics } = await check(doc, id);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("execution failed");
        }
    });
});

describe.each(["swagger2", "openapi3"] satisfies Dialect[])("%s native MIME and transport", (dialect) => {
    test.each(["yaml", "json", "flow"] as const)("%s media declarations satisfy rules without fake header parameters", async (format) => {
        const op = bodyOperation(dialect);
        const doc = document(dialect, { post: op });
        for (const id of [requestMime, responseMime, bodyMime]) {
            expect((await check(doc, id, undefined, format)).diagnostics).toEqual([]);
        }
        const wrongRequest = document(dialect, { post: bodyOperation(dialect, ["text/plain"]) });
        expect((await check(wrongRequest, requestMime, undefined, format)).diagnostics).toEqual([]);
        expect((await check(wrongRequest, responseMime, undefined, format)).diagnostics).toEqual([]);
        expect((await check(wrongRequest, bodyMime, undefined, format)).diagnostics).toHaveLength(1);
        const wrongResponse = document(dialect, { post: bodyOperation(dialect, ["application/json"], ["text/plain"]) });
        expect((await check(wrongResponse, responseMime, undefined, format)).diagnostics).toHaveLength(1);
        expect((await check(wrongResponse, bodyMime, undefined, format)).diagnostics).toHaveLength(1);
    });

    test("additional representations and parameterized MIME are not rejected", async () => {
        const types = ['Application/JSON; profile="a;b"; charset="UTF-8"', "application/xml"];
        const doc = document(dialect, { post: bodyOperation(dialect, types, types) });
        expect((await check(doc, bodyMime)).diagnostics).toEqual([]);
        expect((await check(doc, responseMime)).diagnostics).toEqual([]);
        const bson = document(dialect, { post: bodyOperation(dialect, ["application/bson"], ["application/bson"]) });
        expect((await check(bson, bodyMime)).diagnostics).toEqual([]);
        expect((await check(bson, responseMime)).diagnostics).toHaveLength(1);
    });

    test.each(["yaml", "json", "flow"] as const)("explicit non-UTF-8 JSON highlights the %s declaration", async (format) => {
        const media = "application/json; charset=UTF-16";
        const doc = document(dialect, { post: bodyOperation(dialect, ["application/json"],
            ["application/json", media]) });
        const { diagnostics, content } = await check(doc, responseMime, undefined, format);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("charset must be UTF-8");
        expect(content.slice(diagnostics[0].from, diagnostics[0].to))
            .toBe(format === "json" ? JSON.stringify(media) : media);
    });

    test("unknown/empty request MIME is not assumed JSON; no-body responses remain skipped", async () => {
        const op = bodyOperation(dialect, []);
        const doc = document(dialect, { post: op });
        expect((await check(doc, requestMime)).diagnostics).toHaveLength(1);
        delete op.requestBody;
        op.parameters = [];
        op.responses = { "204": { description: "No body" } };
        expect((await check(doc, bodyMime)).diagnostics).toEqual([]);
        expect((await check(doc, responseMime)).diagnostics).toEqual([]);
    });

    test.each(["root", "operation", "empty", "relative", "missing", "none"])("%s transport and overrides are explicit", async (mode) => {
        const transport = (secure: boolean): Doc => dialect === "swagger2"
            ? { schemes: [secure ? "https" : "http"] }
            : { servers: [{ url: `${secure ? "https" : "http"}://example.invalid/` }] };
        const op: Doc = { responses: {} };
        const item: Doc = { get: op, post: { responses: {} } };
        const doc = document(dialect, mode === "none" ? {} : item, transport(mode !== "root" && mode !== "none"));
        if (mode === "operation") Object.assign(op, transport(false));
        if (mode === "empty") Object.assign(op, dialect === "swagger2" ? { schemes: [] } : { servers: [] });
        if (mode === "missing") {
            delete doc.schemes;
            delete doc.servers;
        }
        if (mode === "relative") {
            if (dialect === "swagger2") doc.schemes = ["ws"];
            else doc.servers = [{ url: "/v1" }];
        }
        const { diagnostics } = await check(doc, https);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).not.toContain("execution failed");
        Object.assign(doc, transport(false));
        Object.assign(op, transport(true));
        item.post = { ...transport(true), responses: {} };
        if (mode !== "none") expect((await check(doc, https)).diagnostics).toEqual([]);
    });

    test("missing and external selected references fail with their rule ID rather than pass", async () => {
        const doc = document(dialect, { post: { responses: { "200": { $ref: "other.yaml#/Response" } } } });
        for (const id of [bodyMime, requestId, custom]) {
            const { diagnostics } = await check(doc, id);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("execution failed");
        }
    });
});

test("OAS3 path servers override root; undetermined scheme templates never imply HTTPS", async () => {
    const doc = document("openapi3", { servers: [{ url: "https://{host}/" }], get: { responses: {} } },
        { servers: [{ url: "http://example.invalid/" }] });
    expect((await check(doc, https)).diagnostics).toEqual([]);
    object(object(doc.paths)["/items"]).servers = [{
        url: "{scheme}://example.invalid/", variables: { scheme: { default: "https" } },
    }];
    const { diagnostics } = await check(doc, https);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("protocol is undetermined");
});

test("v2 formData has a request body and uses effective consumes without inventing requestBody", async () => {
    const doc = document("swagger2", { post: {
        parameters: [{ name: "file", in: "formData", type: "file" }], responses: {},
    } }, { consumes: ["multipart/form-data"] });
    expect((await check(doc, requestMime)).diagnostics).toEqual([]);
    expect(doc).not.toHaveProperty("requestBody");
    expect((await check(doc, bodyMime)).diagnostics).toHaveLength(1);
});

test.each(["[", "", undefined])("custom-header pattern %j is an explicit rule failure", async (pattern) => {
    const doc = document("openapi3", { get: { responses: {} } });
    const { diagnostics } = await check(doc, custom, { header_format: pattern });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("execution failed");
});

test.each(["application/json\n", "application/json; charset=UTF-8; charset=UTF-16",
    'application/json; profile="unterminated', "not-a-media-type"])("invalid MIME %j fails explicitly", (value) => {
    expect(() => parseDeclaredMediaType(value, "#/content")).toThrow();
});

test("quoted MIME parameters retain semicolons and escapes while charset remains independently readable", () => {
    const result = parseDeclaredMediaType('application/json; profile="a;b"; charset="UTF\\-8"', "#");
    expect(result.base).toBe("application/json");
    expect(result.parameters.get("profile")).toBe("a;b");
    expect(result.parameters.get("charset")).toBe("UTF-8");
});

test("legacy response-header callers may still pass paths or Map-based paths explicitly", async () => {
    const paths = { "/items": { get: { responses: { "200": {
        content: { "application/json": {} }, description: "OK",
    } } } } };
    const content = yaml.dump(paths);
    const rule = ruleFor(requestId);
    for (const spec of [paths, new Map(Object.entries(paths)), { paths: new Map(Object.entries(paths)) }]) {
        const diagnostics = await functionsMap.checkResponseHeader(spec, content, rule);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].source).toContain(requestId);
    }
});

test.each(["swagger2", "openapi3"] satisfies Dialect[])("%s direct rule consumers preserve frozen native nodes", async (dialect) => {
    const op = bodyOperation(dialect);
    const item: Doc = { post: op };
    const doc = document(dialect, item, dialect === "swagger2"
        ? { schemes: ["https"] } : { servers: [{ url: "https://example.invalid/" }] });
    const freeze = (value: unknown): void => {
        if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    };
    freeze(doc);
    const content = yaml.dump(doc);
    for (const id of [requestMime, responseMime, bodyMime, https, allowed, auth, custom, requestId, sensitive]) {
        const rule = ruleFor(id);
        const before = JSON.stringify(doc);
        const result = await functionsMap[rule.call.function](doc, content, rule);
        expect(Array.isArray(result)).toBe(true);
        expect(JSON.stringify(doc)).toBe(before);
        expect(object(object(doc.paths)["/items"]).post).toBe(op);
    }
});
