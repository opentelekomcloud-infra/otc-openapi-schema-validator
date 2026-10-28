import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import {
    array, buildScenario, object, type Dialect, type JsonObject,
} from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Native batch checks must not fetch a baseline."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Native batch checks must not fetch a baseline."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native batch checks must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Native batch checks must not convert."); }),
}), { virtual: true });

type Format = "yaml" | "flow" | "json";
const formats: Format[] = ["yaml", "flow", "json"];
const cases = [
    { id: "STS-030-01-2507-2507-M-1", scenario: "batchMethod" },
    { id: "STS-030-01-2507-2507-M-2", scenario: "batchPayload" },
    { id: "STS-030-01-2507-2507-M-3", scenario: "batchSync" },
    { id: "ASY-010-01-2507-2507-M", scenario: "batchAsync" },
] as const;
const rules = new Map<string, AutoRule>();

beforeAll(async () => {
    const catalog = await loadRuleCatalog(
        [`${process.cwd()}/public/rulesets/default/Batch_Resource_Operations.yaml`],
        (file) => fs.readFile(file, "utf8"),
    );
    for (const rule of getImplementedRules(catalog, functionsMap)) rules.set(rule.id, rule);
    expect(rules.size).toBe(4);
});
beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native batch checks must not access the network."));
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

function fixture(dialect: Dialect, index: number, variant: "positive" | "negative" = "negative") {
    const entry = cases[index];
    const rule = rules.get(entry.id);
    if (!rule) throw new Error(`Missing batch rule ${entry.id}`);
    const spec = buildScenario(entry.scenario, dialect, variant, rule);
    const [path, value] = Object.entries(object(spec.paths))[0];
    const pathItem = object(value);
    const method = index === 0 && variant === "negative" ? "put" : "post";
    return { spec, path, pathItem, method, operation: object(pathItem[method]), rule };
}
type Fixture = ReturnType<typeof fixture>;

function text(spec: JsonObject, format: Format = "yaml"): string {
    return format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) });
}
async function check(value: Fixture, params: JsonObject = {}, format: Format = "yaml", executionError = false) {
    const { spec, rule: base } = value;
    const rule = { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
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
    return diagnostics;
}
function refPath(value: Fixture): void {
    value.spec["x-path-items"] = { Alias: { $ref: "#/x-path-items/Batch" }, Batch: value.pathItem };
    value.spec.paths = { [value.path]: { $ref: "#/x-path-items/Alias" } };
}
function store(spec: JsonObject, dialect: Dialect, section: "schemas" | "responses" | "parameters", name: string, node: JsonObject) {
    const owner = dialect === "swagger2" ? spec : object(spec.components);
    const key = dialect === "swagger2" && section === "schemas" ? "definitions" : section;
    if (owner[key] === undefined) owner[key] = {};
    object(owner[key])[name] = node;
    return { $ref: `#/${dialect === "swagger2" ? "" : "components/"}${key}/${name}` };
}
function request(value: Fixture, dialect: Dialect, schema: JsonObject): void {
    if (dialect === "swagger2") {
        value.operation.parameters = [{ name: "body", in: "body", schema }];
    } else {
        value.operation.requestBody = { content: { "application/json": { schema } } };
    }
}
function response(dialect: Dialect, schema: JsonObject): JsonObject {
    return { description: "Batch response", ...(dialect === "swagger2"
        ? { schema } : { content: { "application/json": { schema } } }) };
}
function listSchema(status = true, marker = false): JsonObject {
    return { type: "object", properties: {
        ...(marker ? { all_success: { type: "boolean" } } : {}),
        results: { type: "array", items: { type: "object", properties: status
            ? { status: { type: "string" } } : { id: { type: "string" } } } },
    } };
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s native batch contracts", (dialect) => {
    describe.each(cases.map((entry, index) => ({ ...entry, index })))("$id", ({ index }) => {
        test.each(formats)("%s checks positive and negative operations through chained Path Item refs", async (format) => {
            for (const variant of ["positive", "negative"] as const) {
                const value = fixture(dialect, index, variant);
                refPath(value);
                const findings = await check(value, {}, format);
                expect(findings).toHaveLength(variant === "positive" ? 0 : 1);
                if (findings.length) expect(findings[0].message).toContain(
                    index === 0 ? "Allowed methods" : index === 1 ? "Request body schema must be array<object>"
                        : index === 2 ? "each item must expose a status field" : "job identifier fields",
                );
            }
        });
        test("ignores metadata, non-path entries and unsupported method names even with empty methodsToScan", async () => {
            const value = fixture(dialect, index);
            value.spec.paths = {
                [value.path]: {
                    "x-preview": value.operation, summary: "Batch metadata", servers: [value.operation],
                    parameters: [], connect: value.operation,
                },
                "x-not-a-path": { [value.method]: value.operation },
            };
            expect(await check(value, { methodsToScan: [] })).toEqual([]);
        });
        test("retains configured method scopes", async () => {
            const value = fixture(dialect, index);
            refPath(value);
            expect(await check(value, { methodsToScan: ["head"] })).toEqual([]);
            expect(await check(value, { methodsToScan: [value.method.toUpperCase()] })).toHaveLength(1);
        });
        test.each(["#/missing", "external.yaml#/Batch", "#/x-path-items/Loop"])(
            "necessary Path Item ref %s is an explicit selected-rule error", async (reference) => {
                const value = fixture(dialect, index);
                value.spec["x-path-items"] = { Loop: { $ref: "#/x-path-items/Loop" } };
                value.spec.paths = { [value.path]: { $ref: reference } };
                await check(value, {}, "json", true);
            },
        );
        test("keeps the conservative detector gate for payloads without a configured indicator", async () => {
            const value = fixture(dialect, index);
            value.operation.summary = "Modify resources";
            value.operation.description = "Modify resources";
            value.operation.operationId = "modifyResources";
            value.spec.paths = { "/v1/resources": value.pathItem };
            request(value, dialect, { $ref: "unselected.yaml#/Payload" });
            expect(await check(value)).toEqual([]);
        });
        test("action-style endpoints still require a batch-looking payload when no keyword matches", async () => {
            const value = fixture(dialect, index);
            value.operation.summary = "Modify resources";
            value.operation.description = "";
            value.operation.operationId = "modifyResources";
            value.spec.paths = { "/v1/resources/action": value.pathItem };
            request(value, dialect, { type: "object", properties: { name: { type: "string" } } });
            expect(await check(value)).toEqual([]);
        });
    });

    test("POST allowedMethods override remains effective through Path Item refs", async () => {
        const value = fixture(dialect, 0);
        refPath(value);
        expect(await check(value, { allowedMethods: ["POST", "PUT"] })).toEqual([]);
    });
    test("TRACE is an operation only for OpenAPI 3, and POST rule retains its default scan list", async () => {
        const value = fixture(dialect, 0);
        value.pathItem.trace = value.operation;
        delete value.pathItem[value.method];
        expect(await check(value)).toEqual([]);
        expect(await check(value, { methodsToScan: [] })).toHaveLength(dialect === "swagger2" ? 0 : 1);
    });
    test("action+tags detection reads native local schema refs without conversion", async () => {
        const value = fixture(dialect, 0);
        value.operation.summary = "Tags action";
        value.operation.description = "";
        value.operation.operationId = "modifyTags";
        value.spec.paths = { "/v1/tags/action": value.pathItem };
        const schema = store(value.spec, dialect, "schemas", "TagsBatch", { type: "object", properties: {
            action: { type: "string", enum: ["create", "delete"] },
            tags: { type: "array", items: { type: "object", properties: { key: { type: "string" } } } },
        } });
        request(value, dialect, schema);
        expect(await check(value)).toHaveLength(1);
    });
    test("payload flags retain their existing independent acceptance branches", async () => {
        const value = fixture(dialect, 1, "positive");
        refPath(value);
        const flags = { allowTopLevelArray: false, allowObjectWrapperWithAnyArrayOfObjects: false,
            allowActionEnumCreateDeleteWithTagsArray: false };
        expect(await check(value, { payload: flags })).toHaveLength(1);
        expect(await check(value, { payload: { ...flags, allowTopLevelArray: true } })).toEqual([]);
        request(value, dialect, { type: "object", properties: {
            resources: { type: "array", items: { type: "object" } },
        } });
        expect(await check(value, { payload: { ...flags, allowTopLevelArray: true } })).toHaveLength(1);
        expect(await check(value, { payload: { ...flags, allowObjectWrapperWithAnyArrayOfObjects: true } })).toEqual([]);
        request(value, dialect, { type: "object", properties: {
            action: { type: "string", enum: ["delete"] }, tags: { type: "array", items: { type: "object" } },
        } });
        expect(await check(value, { payload: { ...flags, allowActionEnumCreateDeleteWithTagsArray: true } })).toEqual([]);
    });
    test.each([201, 202, 203, 204, 206])("sync preserves 200-only scope and skips %s even with an invalid schema ref", async (status) => {
        const value = fixture(dialect, 2);
        value.operation.responses = { [String(status)]: { $ref: "unselected.yaml#/Response" } };
        refPath(value);
        expect(await check(value)).toEqual([]);
    });
    test.each([
        { mode: "perItem", schema: {}, count: 1, message: "as an array" },
        { mode: "perItem", schema: listSchema(false), count: 1, message: "item-level status field" },
        { mode: "perItem", schema: listSchema(), count: 0, message: "" },
        { mode: "allOrNothing", schema: listSchema(), count: 1, message: "must be omitted" },
        { mode: "allOrNothing", schema: listSchema(false), count: 0, message: "" },
        { mode: "auto", schema: listSchema(true, true), count: 1, message: "markers are present" },
        { mode: "auto", schema: listSchema(false, true), count: 0, message: "" },
    ])("sync retains $mode policy with reusable responses and schemas", async ({ mode, schema, count, message }) => {
        const value = fixture(dialect, 2);
        const schemaRef = store(value.spec, dialect, "schemas", "SyncBatch", schema);
        const responseRef = store(value.spec, dialect, "responses", "SyncBatch", response(dialect, schemaRef));
        value.operation.responses = { "200": responseRef };
        refPath(value);
        const findings = await check(value, { mode });
        expect(findings).toHaveLength(count);
        if (count) expect(findings[0].message).toContain(message);
    });
    test("sync MIME gate avoids unselected schema refs and no-schema bodies remain skipped", async () => {
        const value = fixture(dialect, 2);
        value.operation.responses = { "200": dialect === "swagger2"
            ? { schema: { $ref: "unselected.yaml#/Payload" } }
            : { content: { "text/plain": { schema: { $ref: "unselected.yaml#/Payload" } } } } };
        value.operation.produces = ["text/plain"];
        refPath(value);
        expect(await check(value)).toEqual([]);
        await check(value, { onlyIfResponseHasContent: false }, "yaml", true);
        value.operation.responses = { "200": { description: "No body" } };
        expect(await check(value)).toEqual([]);
    });
    test("async reads reusable response/schema and enforces optional array list without changing classification", async () => {
        const value = fixture(dialect, 3);
        const schema = { type: "object", properties: { task_id: { type: "string" } } };
        const schemaRef = store(value.spec, dialect, "schemas", "AsyncBatch", schema);
        value.operation.responses = { "202": store(value.spec, dialect, "responses", "AsyncBatch", response(dialect, schemaRef)) };
        refPath(value);
        expect(await check(value)).toEqual([]);
        const require = { statusCode: "202", jobIdAnyOf: ["task_id"], resourcesListRequired: true, resourcesListAnyOf: ["items"] };
        expect(await check(value, { require })).toHaveLength(1);
        object(schema.properties).items = { type: "string" };
        expect(await check(value, { require })).toHaveLength(1);
        object(schema.properties).items = { type: "array", items: { type: "string" } };
        expect(await check(value, { require })).toEqual([]);
        value.operation.responses = { "200": response(dialect, {}) };
        value.operation.summary = "Process batch asynchronously";
        expect(await check(value)).toEqual([]);
    });
    test("async custom detection and required status remain distinct", async () => {
        const value = fixture(dialect, 3);
        value.operation.responses = { "201": response(dialect, {}) };
        const params = { asyncMatch: { successStatusCode: "201" }, require: {
            statusCode: "202", jobIdAnyOf: ["job_id"],
        } };
        expect((await check(value, params))[0].message).toContain("Expected async success status code '202'");
        object(value.operation.responses)["202"] = response(dialect, { type: "object", properties: { job_id: { type: "string" } } });
        expect(await check(value, params)).toEqual([]);
    });
    test.each([1, 2, 3])("selected request/response schema errors are not false PASS for rule index %s", async (index) => {
        const value = fixture(dialect, index);
        if (index === 1) request(value, dialect, { $ref: "#/missing" });
        else value.operation.responses = { [index === 2 ? "200" : "202"]: response(dialect, { $ref: "#/missing" }) };
        refPath(value);
        await check(value, {}, "yaml", true);
    });
    test.each([0, 1, 2, 3])("rule index %s leaves frozen native declarations and refs unchanged", async (index) => {
        const value = fixture(dialect, index);
        refPath(value);
        const before = JSON.stringify(value.spec);
        const queue: unknown[] = [value.spec];
        for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
            if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
                queue.push(...Object.values(item));
                Object.freeze(item);
            }
        }
        const diagnostics = await functionsMap[value.rule.call.function](value.spec, text(value.spec), value.rule);
        expect(diagnostics).toHaveLength(1);
        expect(JSON.stringify(value.spec)).toBe(before);
    });
});

test.each(cases.map((entry, index) => ({ ...entry, index })))(
    "$id reads inherited referenced Swagger body under a referenced Path Item", async ({ index }) => {
        for (const variant of ["positive", "negative"] as const) {
            const value = fixture("swagger2", index, variant);
            const parameters = array(value.operation.parameters).map(object);
            const body = parameters.find((parameter) => parameter.in === "body");
            if (!body) throw new Error("Missing native Swagger body fixture");
            if (index === 0) {
                body.schema = { type: "array", items: { type: "object" } };
                value.operation.summary = "Modify resources";
                value.operation.description = "";
                value.operation.operationId = "modifyResources";
                value.spec.paths = { "/v1/resources/action": value.pathItem };
                value.path = "/v1/resources/action";
            }
            value.pathItem.parameters = [store(value.spec, "swagger2", "parameters", "InheritedBody", body)];
            value.operation.parameters = parameters.filter((parameter) => parameter.in !== "body");
            refPath(value);
            expect(await check(value)).toHaveLength(variant === "positive" ? 0 : 1);
        }
    },
);
test("Swagger body operation override wins over an inherited invalid payload", async () => {
    const value = fixture("swagger2", 1, "positive");
    value.pathItem.parameters = [{ name: "body", in: "body", schema: { type: "string" } }];
    request(value, "swagger2", { type: "array", items: { type: "object" } });
    refPath(value);
    expect(await check(value)).toEqual([]);
});
test("Swagger formData arrays of primitives are not accepted as array<object>", async () => {
    const value = fixture("swagger2", 1, "positive");
    value.operation.parameters = [{ name: "ids", in: "formData", type: "array",
        items: { type: "string" }, collectionFormat: "multi" }];
    value.operation.consumes = ["multipart/form-data"];
    refPath(value);
    expect(await check(value)).toHaveLength(1);
});
test("Swagger sync unknown produces still validates its response schema", async () => {
    const value = fixture("swagger2", 2);
    delete value.spec.produces;
    delete value.operation.produces;
    refPath(value);
    expect(await check(value)).toHaveLength(1);
});
test("OpenAPI reusable requestBody and preferred media retain native selection", async () => {
    const value = fixture("openapi3", 1, "positive");
    const components = object(value.spec.components);
    components.requestBodies = { Batch: { content: {
        "application/json": { schema: { type: "string" } },
        "application/xml": { schema: { type: "array", items: { type: "object" } } },
    } } };
    value.operation.requestBody = { $ref: "#/components/requestBodies/Batch" };
    refPath(value);
    expect(await check(value)).toHaveLength(1);
    expect(await check(value, { payload: { contentTypesPreferred: ["application/xml"] } })).toEqual([]);
});
