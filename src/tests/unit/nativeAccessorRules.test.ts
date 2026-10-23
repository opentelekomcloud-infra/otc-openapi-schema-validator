import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
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
}));

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

async function check(spec: JsonObject, rule: AutoRule) {
    return (await runLinter(yaml.dump(spec, { lineWidth: -1, noRefs: true }), [rule])).diagnostics;
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
