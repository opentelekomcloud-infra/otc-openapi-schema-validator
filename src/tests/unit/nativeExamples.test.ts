import { parseNativeOpenApi } from "@/lib/openapi/parseNativeOpenApi";
import { collectNativeOperations } from "@/lib/openapi/operations";
import { collectRequestExamples, collectResponseExamples } from "@/lib/openapi/examples";
import { readFixtureContent, type Dialect } from "../fixtures/dual-version/scenarios";

beforeEach(() => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network access is forbidden."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s native examples", (dialect) => {
    test.each(["", "-form-data", "-reusables", "-inheritance"])("preserves original fixture %s and example values", (suffix) => {
        const content = readFixtureContent(dialect, suffix);
        const native = parseNativeOpenApi(content);
        freeze(native.document);
        const before = JSON.stringify(native.document);
        for (const op of collectNativeOperations(native)) {
            const request = collectRequestExamples(op.operation, op.pathItem, native.document, {}, new Map(), {
                operation: op.pointer, pathItem: op.resolvedPathItemPointer,
            });
            const response = collectResponseExamples(op.operation, Object.keys(op.operation.responses ?? {}), native.document, {}, new Map(), op.pointer);
            for (const entry of [...request, ...response]) {
                expect(entry.pointer).toMatch(/^#\//);
                expect(entry.source).toBe(entry.pointer);
                expect(entry).toHaveProperty("value");
                expect(entry.direction).toBe(request.includes(entry) ? "request" : "response");
            }
        }
        expect(JSON.stringify(native.document)).toBe(before);
        expect(native.originalContent).toBe(content);
    });

    test("root schema example is a payload fallback; property examples are separate", () => {
        const schema = { type: "object", example: { count: 3 }, properties: { count: { type: "integer", example: 3 } } };
        const operation = dialect === "swagger2"
            ? { responses: { "200": { schema } } }
            : { responses: { "200": { content: { "application/json": { schema } } } } };
        const document = dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" };
        const examples = collectResponseExamples(operation, ["200"], document, {});
        expect(examples.map((entry) => [entry.scope, entry.value])).toEqual([["payload", schema.example], ["property", 3]]);
        expect(examples[0].value).toBe(schema.example);
        expect(examples.every((entry) => entry.statusCode === "200")).toBe(true);
    });

    test("property examples alone never become whole-body examples", () => {
        const schema = { type: "object", properties: { name: { type: "string", example: "sample" } } };
        const operation = dialect === "swagger2" ? { parameters: [{ name: "body", in: "body", schema }] }
            : { requestBody: { content: { "application/json": { schema } } } };
        const document = dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" };
        const found = collectRequestExamples(operation, {}, document, {});
        expect(found).toHaveLength(1);
        expect(found[0].scope).toBe("property");
        expect(found[0].value).toBe("sample");
    });
});

test.each([null, false, 0, "", [], {}])("Swagger response example %j is retained as an explicit payload", (value) => {
    const operation = { responses: { "200": { schema: {}, examples: { "application/json": value } } } };
    const [found] = collectResponseExamples(operation, ["200"], { swagger: "2.0" }, {});
    expect(found.value).toBe(value);
    expect(found.scope).toBe("payload");
    expect(found.mediaType).toBe("application/json");
    expect(found.pointer).toBe("#/responses/200/examples/application~1json");
});

test("v2 media payload examples override root fallback without hiding individual property examples", () => {
    const schema = { example: { id: "schema" }, properties: { id: { type: "string", example: "property" } } };
    const actual = { id: "actual" };
    const operation = { responses: { "200": { schema, examples: { "application/json": actual } } } };
    const found = collectResponseExamples(operation, ["200"], { swagger: "2.0" }, {});
    expect(found.map((entry) => entry.value)).toEqual([actual, "property"]);
    expect(found[0].value).toBe(actual);
});

test("v2 inherited reusable body schema.example is found without using parameter example/default", () => {
    const value = { name: "sample" };
    const schema = { type: "object", example: value };
    const document = { swagger: "2.0", definitions: { Body: schema }, parameters: {
        Body: { name: "container", in: "body", schema: { $ref: "#/definitions/Body" }, example: "not a standard source", default: "not an example" },
    } };
    const found = collectRequestExamples({}, { parameters: [{ $ref: "#/parameters/Body" }] }, document, {});
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(value);
    expect(found[0].pointer).toBe("#/definitions/Body/example");
    expect(found[0].mediaType).toBeUndefined();
});

test("v2 formData examples/defaults do not fabricate a payload", () => {
    const operation = { parameters: [{ name: "caption", in: "formData", type: "string", example: "ignored", default: "ignored" }] };
    expect(collectRequestExamples(operation, {}, { swagger: "2.0" }, {})).toEqual([]);
});

test("OAS3 requestBody, response and named Example refs preserve declaration and final value pointers", () => {
    const value = { $ref: "literal payload data, not a schema ref" };
    const media = { schema: { type: "object", properties: { $ref: { type: "string" } } }, examples: { "a/b~": { $ref: "#/components/examples/Alias" } } };
    const document = { openapi: "3.0.3", components: {
        examples: { Alias: { $ref: "#/components/examples/Value" }, Value: { value } },
        requestBodies: { Body: { content: { "application/json": media } } },
        responses: { Body: { content: { "application/json": media } } },
    } };
    freeze(document);
    const request = collectRequestExamples({ requestBody: { $ref: "#/components/requestBodies/Body" } }, {}, document, {});
    const response = collectResponseExamples({ responses: { "201": { $ref: "#/components/responses/Body" } } }, ["201"], document, {});
    for (const entry of [...request, ...response]) {
        expect(entry.value).toBe(value);
        expect(entry.pointer).toBe("#/components/examples/Value/value");
        expect(entry.resolvedPointer).toBe("#/components/examples/Value");
        expect(entry.declarationPointer).toMatch(/\/content\/application~1json\/examples\/a~1b~0$/);
    }
});

test("OAS3 root fallback is media-specific and does not replace explicit examples", () => {
    const jsonSchema = { type: "object", example: { json: true } };
    const textSchema = { type: "string", example: "fallback" };
    const operation = { responses: { "200": { content: {
        "application/json": { schema: jsonSchema },
        "text/plain": { schema: textSchema, example: "explicit" },
    } } } };
    const found = collectResponseExamples(operation, ["200"], { openapi: "3.0.3" }, {});
    expect(found.map((entry) => [entry.mediaType, entry.value])).toEqual([
        ["application/json", jsonSchema.example], ["text/plain", "explicit"],
    ]);
});

test.each([
    { value: { $ref: "#/missing" }, message: "Local reference does not exist" },
    { value: { $ref: "external.yaml#/Example" }, message: "External references are unsupported" },
    { value: { externalValue: "https://fixtures.example.invalid/example.json" }, message: "External example payloads are unsupported" },
    { value: {}, message: "Example Object has no inline value" },
])("invalid/unavailable named example: $message", ({ value, message }) => {
    const operation = { responses: { "200": { content: { "application/json": { examples: { Sample: value } } } } } };
    expect(() => collectResponseExamples(operation, ["200"], { openapi: "3.0.3" }, {})).toThrow(message);
});

test("schema recursion terminates while repeated property references retain a concrete source", () => {
    const node = { type: "object", properties: { value: { type: "string", example: "sample" }, child: { $ref: "#/definitions/Node" } } };
    const document = { swagger: "2.0", definitions: { Node: node } };
    const found = collectResponseExamples({ responses: { "200": { schema: { $ref: "#/definitions/Node" } } } }, ["200"], document, {});
    expect(found).toHaveLength(1);
    expect(found[0].pointer).toBe("#/definitions/Node/properties/value/example");
});

test("source configuration and status selection are honored rather than silently broadened", () => {
    const operation = { responses: { "200": { schema: { example: "schema" }, examples: { "text/plain": "response" } } } };
    expect(collectResponseExamples(operation, ["201"], { swagger: "2.0" }, {})).toEqual([]);
    expect(collectResponseExamples(operation, ["200"], { swagger: "2.0" }, { exampleSources: { response: ["content.example"] } })).toEqual([]);
    expect(() => collectResponseExamples(operation, ["200"], { swagger: "2.0" }, { exampleSources: { response: ["typo"] } }))
        .toThrow("Unsupported exampleSources.response");
});
