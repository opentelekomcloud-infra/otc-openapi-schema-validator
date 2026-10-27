import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { sourceMap } from "@/lib/openapi/sourceMap";
import { jsonPointer, NativeReferenceError } from "@/lib/openapi/references";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import {
    array, buildScenario, object, readFixture, schemas, type Dialect, type JsonObject,
} from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Unexpected baseline lookup."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Unexpected baseline fetch."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native checks must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Native checks must not convert documents."); }),
}), { virtual: true });

const rules = new Map<string, AutoRule>();
const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");

beforeAll(async () => {
    const root = path.join(process.cwd(), "public/rulesets/default");
    const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml")).map((file) => path.join(root, file));
    const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.id, rule);
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
});

afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fetchRepoMap).not.toHaveBeenCalled();
    expect(fetchSpecFromGitea).not.toHaveBeenCalled();
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function ruleFor(id: string): AutoRule {
    const rule = rules.get(id);
    if (!rule) throw new Error(`Missing catalog rule: ${id}`);
    return rule;
}

async function check(spec: JsonObject, rule: AutoRule, format: "yaml" | "json" = "yaml") {
    return (await runLinter(format === "json" ? JSON.stringify(spec) : yaml.dump(spec, { lineWidth: -1, noRefs: true }), [rule])).diagnostics;
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s real parameter rules", (dialect) => {
    test.each(["positive", "negative"] as const)("Authorization header %s uses its native type", async (variant) => {
        const rule = ruleFor("HDR-010-01-2507-2507-M-3");
        const spec = buildScenario("requiredHeader", dialect, variant, rule);
        const diagnostics = await check(spec, rule);
        if (variant === "positive") expect(diagnostics).toEqual([]);
        else {
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0]).toMatchObject({ source: getSource(rule), message: rule.message });
        }
    });

    test.each(["positive", "negative"] as const)("GET Content-Type prohibition %s uses its native type", async (variant) => {
        const rule = ruleFor("COD-020-01-2507-2507-M-1");
        const spec = buildScenario("forbiddenHeader", dialect, variant, rule);
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
        if (diagnostics.length) {
            expect(diagnostics[0]).toMatchObject({ source: getSource(rule), message: rule.message });
        }
    });

    test("missing/external/circular parameter refs become errors for the selected rule", async () => {
        const rule = ruleFor("HDR-010-01-2507-2507-M-3");
        for (const reference of ["#/missing", "external.yaml#/Token", "#/x-parameters/Loop"]) {
            const spec = buildScenario("requiredHeader", dialect, "positive", rule);
            const pathItem = object(Object.values(object(spec.paths))[0]);
            const operation = object(pathItem.post);
            operation.parameters = [{ $ref: reference }];
            spec["x-parameters"] = { Loop: { $ref: "#/x-parameters/Loop" } };
            const diagnostics = await check(spec, rule);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0]).toMatchObject({
                source: getSource(rule), severity: "error", message: expect.stringContaining("execution failed"),
            });
        }
    });
});

test.each(["chain", "missing", "external", "circular"] as const)(
    "DOC-040 shared schema resolution: %s", async (variant) => {
        const rule = ruleFor("DOC-040-01-2507-2507-M");
        const spec = buildScenario("examples", "openapi3", "positive", rule);
        const definitions = schemas(spec, "openapi3");
        definitions.Target = definitions.Resource;
        definitions.Resource = {
            $ref: variant === "chain" ? "#/components/schemas/Alias"
                : variant === "missing" ? "#/components/schemas/Missing"
                    : variant === "external" ? "external.yaml#/Resource" : "#/components/schemas/Resource",
        };
        definitions.Alias = { $ref: "#/components/schemas/Target" };
        const diagnostics = await check(spec, rule);
        if (variant === "chain") expect(diagnostics).toEqual([]);
        else {
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0]).toMatchObject({
                source: getSource(rule), severity: "error", message: expect.stringContaining("execution failed"),
            });
        }
    },
);

test("sorting validates the operation override, not the superseded path-level parameter", async () => {
    const rule = ruleFor("FIL-030-01-2507-2507-M");
    const spec = buildScenario("sorting", "openapi3", "positive", rule);
    const pathItem = object(Object.values(object(spec.paths))[0]);
    const operation = object(pathItem.get);
    const params = array(operation.parameters);
    pathItem.parameters = [params[0], {
        name: "sort_dir", in: "query", schema: { type: "string", enum: ["sideways"], default: "sideways" },
    }];
    operation.parameters = [params[1]];
    expect(await check(spec, rule)).toEqual([]);
});

test("scope validation includes TRACE on OpenAPI 3", async () => {
    const rule = ruleFor("ARG-040-01-2507-2507-O");
    const spec = buildScenario("projectScope", "openapi3", "negative", rule);
    const pathItem = object(Object.values(object(spec.paths))[0]);
    pathItem.trace = pathItem.get;
    delete pathItem.get;
    const diagnostics = await check(spec, rule);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].source).toBe(getSource(rule));
    expect(diagnostics[0].message).not.toContain("execution failed");
});

describe.each([
    { id: "STS-030-01-2507-2507-M-1", scenario: "batchMethod" },
    { id: "STS-030-01-2507-2507-M-2", scenario: "batchPayload" },
    { id: "STS-030-01-2507-2507-M-3", scenario: "batchSync" },
    { id: "ASY-010-01-2507-2507-M", scenario: "batchAsync" },
] as const)("$id native inherited request payload", ({ id, scenario }) => {
    test.each(["positive", "negative"] as const)("%s: reusable path-level body is not lost", async (variant) => {
        const rule = ruleFor(id);
        const spec = buildScenario(scenario, "swagger2", variant, rule);
        const paths = object(spec.paths);
        const [path, value] = Object.entries(paths)[0];
        const pathItem = object(value);
        const method = scenario === "batchMethod" && variant === "negative" ? "put" : "post";
        const operation = object(pathItem[method]);
        const params = array(operation.parameters).map(object);
        const body = params.find((param) => param.in === "body");
        if (!body) throw new Error("Missing fixture body");
        if (scenario === "batchMethod") {
            body.schema = { type: "array", items: { type: "object" } };
            operation.summary = "Modify resources";
            operation.operationId = "modifyResources";
            delete paths[path];
            paths["/v1/resources/action"] = pathItem;
        }
        spec.parameters = { InheritedBody: body };
        pathItem.parameters = [{ $ref: "#/parameters/InheritedBody" }];
        operation.parameters = params.filter((param) => param.in !== "body");
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
        if (variant === "negative") {
            expect(diagnostics[0].source).toBe(getSource(rule));
            expect(diagnostics[0].message).not.toContain("execution failed");
        }
    });
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s native response gates", (dialect) => {
    test.each(["positive", "negative"] as const)("sync batch reusable response: %s", async (variant) => {
        const rule = ruleFor("STS-030-01-2507-2507-M-3");
        const spec = buildScenario("batchSync", dialect, variant, rule);
        const operation = object(object(Object.values(object(spec.paths))[0]).post);
        const responses = object(operation.responses);
        if (dialect === "swagger2") {
            spec.responses = { Batch: responses["200"] };
            responses["200"] = { $ref: "#/responses/Batch" };
        } else {
            object(spec.components).responses = { Batch: responses["200"] };
            responses["200"] = { $ref: "#/components/responses/Batch" };
        }
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
        if (variant === "negative") expect(diagnostics[0].message).toContain("each item must expose a status field");
    });

    test("nonconfigured response MIME remains excluded without dereferencing its schema", async () => {
        const rule = ruleFor("STS-030-01-2507-2507-M-3");
        const spec = buildScenario("batchSync", dialect, "positive", rule);
        const operation = object(object(Object.values(object(spec.paths))[0]).post);
        if (dialect === "swagger2") {
            operation.produces = ["text/plain"];
            operation.responses = { "200": { schema: { $ref: "external.yaml" } } };
        } else {
            operation.responses = { "200": { content: { "text/plain": { schema: { $ref: "external.yaml" } } } } };
        }
        expect(await check(spec, rule)).toEqual([]);
    });
});

test.each(["positive", "negative"] as const)(
    "approved unknown-MIME policy checks Swagger response schema: %s", async (variant) => {
        const rule = ruleFor("STS-030-01-2507-2507-M-3");
        const spec = buildScenario("batchSync", "swagger2", variant, rule);
        delete spec.produces;
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
        if (variant === "negative") expect(diagnostics[0].message).toContain("each item must expose a status field");
    },
);

describe.each<Dialect>(["swagger2", "openapi3"])("%s filter response reuse", (dialect) => {
    test.each(["positive", "negative"] as const)("common 200 accessor: %s", async (variant) => {
        const rule = ruleFor("FIL-010-01-2507-2507-O");
        const spec = buildScenario("filterField", dialect, variant, rule);
        const operation = object(object(Object.values(object(spec.paths))[0]).get);
        const responses = object(operation.responses);
        if (dialect === "swagger2") {
            spec.responses = { Resource: responses["200"] };
            responses["200"] = { $ref: "#/responses/Resource" };
        } else {
            object(spec.components).responses = { Resource: responses["200"] };
            responses["200"] = { $ref: "#/components/responses/Resource" };
        }
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
        if (variant === "negative") expect(diagnostics[0].message).toContain("Missing in response schema: resource_id");
    });
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s native DOC-040", (dialect) => {
    function postFixture() {
        const spec = readFixture(dialect);
        const operation = object(object(object(spec.paths)["/v1/resources"]).post);
        const pathItem: JsonObject = { post: operation };
        spec.paths = { "/v1/resources": pathItem };
        const definitions = schemas(spec, dialect);
        const requestSchema = object(definitions.ResourceRequest);
        const requestExample = object(requestSchema.example);
        if (dialect === "swagger2") {
            const body = array(operation.parameters).find((param) => object(param).in === "body");
            if (!body) throw new Error("Missing body");
            spec.parameters = { Body: body };
            pathItem.parameters = [{ $ref: "#/parameters/Body" }];
            operation.parameters = [];
        }
        const media = dialect === "openapi3" ? object(object(object(operation.requestBody).content)["application/json"]) : requestSchema;
        return { spec, operation, requestSchema, media, requestExample };
    }

    test("POST required examples accept inherited schema.example or native media example", async () => {
        expect(await check(postFixture().spec, ruleFor("DOC-040-01-2507-2507-M"))).toEqual([]);
    });

    test("serialized structured JSON is decoded without rewriting the example", async () => {
        const { spec, media } = postFixture();
        const value = '{"resource":{"resource_id":"resource-1","name":"sample","status":"active"}}';
        media.example = value;
        expect(await check(spec, ruleFor("DOC-040-01-2507-2507-M"))).toEqual([]);
        expect(media.example).toBe(value);
    });

    test("malformed serialized JSON produces a rule diagnostic, not success or YAML fallback", async () => {
        const { spec, media } = postFixture();
        media.example = '{"resource":}';
        const diagnostics = await check(spec, ruleFor("DOC-040-01-2507-2507-M"));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ source: getSource(ruleFor("DOC-040-01-2507-2507-M")), message: expect.stringContaining("malformed JSON") });
    });

    test("request required and response enum checks use native nested schemas", async () => {
        const { spec, media, operation } = postFixture();
        media.example = { resource: { resource_id: "resource-1", status: "active" } };
        const response = object(object(operation.responses)["201"]);
        if (dialect === "swagger2") object(response.examples)["application/json"] = { resource: { resource_id: "resource-1", name: "sample", status: "invalid" } };
        else object(object(response.content)["application/json"]).example = { resource: { resource_id: "resource-1", name: "sample", status: "invalid" } };
        const diagnostics = await check(spec, ruleFor("DOC-040-01-2507-2507-M"));
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics.some((entry) => entry.message.includes("missing required body field 'resource.name'"))).toBe(true);
        expect(diagnostics.some((entry) => entry.message.includes("enum values"))).toBe(true);
        const content = yaml.dump(spec, { lineWidth: -1, noRefs: true });
        const enumIssue = diagnostics.find((entry) => entry.message.includes("enum values"))!;
        expect(content.slice(enumIssue.from, enumIssue.to)).toBe("invalid");
        const missingField = diagnostics.find((entry) => entry.message.includes("missing required body field"))!;
        expect(content.slice(missingField.from, missingField.to)).toBe("resource");
    });

    test("undefined request fields are not hidden by a valid native payload", async () => {
        const { spec, media, requestExample } = postFixture();
        media.example = { ...requestExample, extra: true };
        const diagnostics = await check(spec, ruleFor("DOC-040-01-2507-2507-M"));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("field 'extra' that is not defined");
    });

    test("response root schema.example satisfies required presence when media examples are absent", async () => {
        const rule = ruleFor("DOC-040-01-2507-2507-M");
        const spec = buildScenario("examples", dialect, "negative", rule);
        object(schemas(spec, dialect).ResourceList).example = { resources: [], count: 0 };
        expect(await check(spec, rule)).toEqual([]);
    });

    test("property examples are checked independently, even when the body example has an empty array", async () => {
        const rule = ruleFor("DOC-040-01-2507-2507-M");
        const spec = buildScenario("examples", dialect, "positive", rule);
        object(object(object(schemas(spec, dialect).Resource).properties).created_at).example = 123;
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("Property example");
        expect(diagnostics[0].message).not.toContain("Missing required");
    });

    test.each(["property-only", "payload"])("DELETE presence policy distinguishes %s examples", async (kind) => {
        const schema: JsonObject = { type: "object", properties: { id: { type: "string", example: "sample" } } };
        const response: JsonObject = dialect === "swagger2" ? { schema } : { content: { "application/json": { schema } } };
        if (kind === "payload") {
            if (dialect === "swagger2") response.examples = { "application/json": { id: "sample" } };
            else object(object(response.content)["application/json"]).example = { id: "sample" };
        }
        const spec: JsonObject = {
            ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
            paths: { "/resources": { delete: { responses: { "200": response } } } },
        };
        const diagnostics = await check(spec, ruleFor("DOC-040-01-2507-2507-M"));
        expect(diagnostics).toHaveLength(kind === "payload" ? 1 : 0);
        if (kind === "payload") expect(diagnostics[0].message).toContain("Response example is not allowed");
    });

    test.each(["absent", "broken-ref"])("a native response example with %s schema cannot silently pass", async (kind) => {
        const rule = ruleFor("DOC-040-01-2507-2507-M");
        const spec = buildScenario("examples", dialect, "positive", rule);
        const operation = object(object(Object.values(object(spec.paths))[0]).get);
        const response = object(object(operation.responses)["200"]);
        const container = dialect === "swagger2" ? response : object(object(response.content)["application/json"]);
        if (kind === "absent") delete container.schema;
        else container.schema = { $ref: "#/missing" };
        const diagnostics = await check(spec, rule);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
            source: getSource(rule), severity: "error",
            message: expect.stringContaining(kind === "absent" ? "no response schema" : "Local reference does not exist"),
        });
    });
});

test("DOC-040 resolves named Example and response refs; externalValue fails explicitly without a fetch", async () => {
    const rule = ruleFor("DOC-040-01-2507-2507-M");
    const spec = buildScenario("examples", "openapi3", "positive", rule);
    const operation = object(object(Object.values(object(spec.paths))[0]).get);
    const response = object(object(operation.responses)["200"]);
    const media = object(object(response.content)["application/json"]);
    const payload = media.example;
    delete media.example;
    media.examples = { Named: { $ref: "#/components/examples/Value" } };
    const components = object(spec.components);
    components.examples = { Value: { value: payload } };
    components.responses = { Value: response };
    operation.responses = { "200": { $ref: "#/components/responses/Value" } };
    expect(await check(spec, rule)).toEqual([]);
    components.examples = { Value: { externalValue: "https://fixtures.example.invalid/example.json" } };
    const diagnostics = await check(spec, rule);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source: getSource(rule), severity: "error", message: expect.stringContaining("External example payloads are unsupported") });
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s exact source diagnostic wiring", (dialect) => {
    test("snake-case diagnostics highlight the native parameter name, not just its method", async () => {
        const rule = ruleFor("ARG-010-01-2507-2509-M");
        const spec = buildScenario("snakeCase", dialect, "negative", rule);
        const content = JSON.stringify(spec);
        const diagnostics = await check(spec, rule, "json");
        expect(diagnostics).toHaveLength(1);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe('"resourceName"');
    });

    test.each(["yaml", "json"] as const)("missing header anchors only its own POST in %s", async (format) => {
        const rule = ruleFor("HDR-010-01-2507-2507-M-3");
        const spec = buildScenario("requiredHeader", dialect, "negative", rule);
        const [path, operation] = Object.entries(object(spec.paths))[0];
        const good = buildScenario("requiredHeader", dialect, "positive", rule);
        spec.paths = { "/decoy": Object.values(object(good.paths))[0], [path]: operation };
        const content = format === "json" ? JSON.stringify(spec) : yaml.dump(spec, { lineWidth: -1, noRefs: true });
        const diagnostics = await check(spec, rule, format);
        expect(diagnostics).toHaveLength(1);
        const expected = sourceMap(content).locate(jsonPointer(["paths", path, "post"]));
        expect(diagnostics[0]).toMatchObject({ from: expected.from, to: expected.to, lineNumber: expected.lineNumber });
        expect(diagnostics[0].from).toBeGreaterThan(content.indexOf("/decoy"));
    });

    test("referenced custom parameter header and response header retain separate concrete sources", async () => {
        const original = ruleFor("HDR-020-01-2507-2507-M-3");
        const rule = { ...original, call: { ...original.call, functionParams: { ...original.call.functionParams, header_format: "^X-[a-z-]+$" } } };
        const parameter = { in: "header", name: "X-Bad", ...(dialect === "swagger2" ? { type: "string" } : { schema: { type: "string" } }) };
        const spec: JsonObject = {
            ...(dialect === "swagger2" ? { swagger: "2.0", parameters: { Header: parameter } }
                : { openapi: "3.0.3", components: { parameters: { Header: parameter } } }),
            paths: { "/resources.responses.a.headers.b": { get: {
                parameters: [{ $ref: dialect === "swagger2" ? "#/parameters/Header" : "#/components/parameters/Header" }],
                responses: { "200": { headers: { "X-Bad": dialect === "swagger2" ? { type: "string" } : { schema: { type: "string" } } } } },
            } } },
        };
        const content = JSON.stringify(spec);
        const diagnostics = await check(spec, rule, "json");
        expect(diagnostics).toHaveLength(2);
        for (const diagnostic of diagnostics) expect(content.slice(diagnostic.from, diagnostic.to)).toBe('"X-Bad"');
        expect(diagnostics[0].from).not.toBe(diagnostics[1].from);
    });

    test("execution errors preserve rule ID and highlight the actual broken reference value", async () => {
        const rule = ruleFor("HDR-010-01-2507-2507-M-3");
        const spec = buildScenario("requiredHeader", dialect, "positive", rule);
        const operation = object(object(Object.values(object(spec.paths))[0]).post);
        operation.parameters = [{ $ref: "#/missing" }];
        const content = JSON.stringify(spec);
        const diagnostics = await check(spec, rule, "json");
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ source: getSource(rule), severity: "error", message: expect.stringContaining("execution failed") });
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe('"#/missing"');
    });
});

test("response header status ranges do not drift after skipped responses or integer-key sorting", async () => {
    const rule = ruleFor("HDR-020-01-2507-2507-M-2");
    const body = { content: { "application/json": { schema: { type: "object" } } } };
    const content = '{"openapi":"3.0.3","paths":{"/skipped":{"get":{"responses":{"200":{"description":"no body"}}}},"/target":{"get":{"responses":{"201":' +
        JSON.stringify(body) + ',"200":' + JSON.stringify(body) + "}}}}}";
    const { diagnostics } = await runLinter(content, [rule]);
    expect(diagnostics).toHaveLength(2);
    for (const [index, status] of ["200", "201"].entries()) {
        const expected = sourceMap(content).locate(jsonPointer(["paths", "/target", "get", "responses", status]));
        expect(diagnostics[index]).toMatchObject({ from: expected.from, to: expected.to });
    }
});

test("a reference failure in a foreign baseline cannot highlight an unrelated current node", async () => {
    const rule = ruleFor("BAS-080-01-2507-2507-M");
    const spec: JsonObject = { openapi: "3.0.3", paths: {}, components: { schemas: { Same: { $ref: "#/current" } } } };
    const content = JSON.stringify(spec);
    const remoteNode = { $ref: "#/missing" };
    jest.spyOn(functionsMap, "checkCompatibility").mockImplementation(() => {
        throw new NativeReferenceError("UNRESOLVED_REFERENCE", "#/missing", "#/components/schemas/Same", "Unavailable baseline target", { sourceNode: remoteNode });
    });
    const diagnostics = await check(spec, rule, "json");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ from: 0, to: content.length, source: getSource(rule), severity: "error", fallback: "missing" });
});

test("snake-case body findings highlight the shared property's own source through refs", async () => {
    const rule = ruleFor("ARG-010-01-2507-2509-M");
    const spec: JsonObject = {
        openapi: "3.0.3",
        paths: { "/v1/resources": { post: {
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Body" } } } },
            responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Body" } } } } },
        } } },
        components: { schemas: { Body: { type: "object", properties: { resourceName: { type: "string" } } } } },
    };
    const content = JSON.stringify(spec);
    const diagnostics = await check(spec, rule, "json");
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) expect(content.slice(diagnostic.from, diagnostic.to)).toBe('"resourceName"');
});

test("time-format findings highlight the failing example value, not another schema's same-named property", async () => {
    const rule = ruleFor("TIM-010-01-2507-2507-M-1");
    const spec = buildScenario("timestamp", "openapi3", "negative", rule);
    const definitions = schemas(spec, "openapi3");
    object(spec.components).schemas = {
        Earlier: { properties: { created_at: { type: "string", example: "2026-01-01T00:00:00Z" } } },
        ...definitions,
    };
    const content = JSON.stringify(spec);
    const diagnostics = await check(spec, rule, "json");
    expect(diagnostics).toHaveLength(1);
    expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe('"not-a-date"');
});
