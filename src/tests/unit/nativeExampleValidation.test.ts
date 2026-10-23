import { collectRequestExamples, collectResponseExamples } from "@/lib/openapi/examples";
import { assertJsonExample, validateExampleValue } from "@/lib/openapi/validateExample";
import { validateRequestExamples, validateResponseExamples } from "@/utils/validation";
import type { RuleConfig } from "@/types/example";

const options = { direction: "request" as const, checkTypes: true, checkRequired: true, forbidUndefined: true };
const config: RuleConfig = {
    jsonStringMode: "serializedWhenStructured",
    requestValidation: { includeRequestBodySchema: true, requireRequiredBodyFields: true, forbidUndefinedFields: true },
    responseValidation: { validateAgainstResponseSchema: true, forbidUndefinedFields: true },
};

function issues(value: unknown, schema: Record<string, unknown>, extra = {}) {
    return validateExampleValue(value, { node: schema, pointer: "#/Schema" }, {}, new Map(), { ...options, ...extra });
}

test.each([
    { type: "object", good: {}, bad: "object" },
    { type: "array", good: [], bad: {} },
    { type: "integer", good: 1, bad: 1.5 },
    { type: "number", good: 1.5, bad: "1" },
    { type: "string", good: "sample", bad: 1 },
    { type: "boolean", good: false, bad: "false" },
])("$type checks the native value without coercion", ({ type, good, bad }) => {
    expect(issues(good, { type })).toEqual([]);
    expect(issues(bad, { type }).some((entry) => entry.code === "type")).toBe(true);
});

test("required fields are checked only in present objects and separately in every array item", () => {
    const child = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
    const schema = { type: "object", properties: { optional: child, entries: { type: "array", items: child } } };
    expect(issues({}, schema)).toEqual([]);
    expect(issues({ entries: [{ id: 1 }, {}] }, schema)).toMatchObject([{ code: "required", path: ["entries", 1, "id"] }]);
});

test("reused schema refs validate all occurrences, including nested required fields", () => {
    const child = { type: "object", required: ["id"], properties: { id: { type: "integer" } } };
    const schema = { type: "object", properties: { a: { $ref: "#/Child" }, b: { $ref: "#/Child" } } };
    const found = validateExampleValue({ a: { id: 1 }, b: {} }, { node: schema, pointer: "#" }, { Child: child }, new Map(), options);
    expect(found).toMatchObject([{ code: "required", path: ["b", "id"] }]);
});

test("recursive schemas validate finite values without suppressing child checks", () => {
    const schema = { type: "object", properties: { id: { type: "integer" }, child: { $ref: "#/Node" } } };
    const found = validateExampleValue({ id: 1, child: { id: "bad" } }, { node: schema, pointer: "#/Node" }, { Node: schema }, new Map(), options);
    expect(found).toMatchObject([{ code: "type", path: ["child", "id"] }]);
});

test("allOf unions declared properties without falsely rejecting fields from another branch", () => {
    const schema = { allOf: [
        { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    ] };
    expect(issues({ id: 1, name: "sample" }, schema)).toEqual([]);
    expect(issues({ id: 1 }, schema)).toMatchObject([{ code: "required", path: ["name"] }]);
});

test.each(["oneOf", "anyOf"])("%s evaluates alternatives instead of requiring every branch", (keyword) => {
    const schema = { [keyword]: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "integer" } } },
    ] };
    expect(issues({ a: "sample" }, schema)).toEqual([]);
    expect(issues({ b: 1 }, schema)).toEqual([]);
    expect(issues({}, schema)).toMatchObject([{ code: "composition" }]);
});

test("oneOf rejects ambiguous values; anyOf accepts them", () => {
    const branches = [{ type: "integer" }, { type: "number" }];
    expect(issues(1, { oneOf: branches })).toMatchObject([{ code: "composition" }]);
    expect(issues(1, { anyOf: branches })).toEqual([]);
});

test("nested allOf and oneOf retain base constraints and terminate", () => {
    const schema = { allOf: [
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        { oneOf: [
            { type: "object", properties: { kind: { type: "string", enum: ["a"] } }, required: ["kind"] },
            { type: "object", properties: { kind: { type: "string", enum: ["b"] } }, required: ["kind"] },
        ] },
    ] };
    expect(issues({ id: 1, kind: "a" }, schema)).toEqual([]);
    expect(issues({ kind: "a" }, schema).length).toBeGreaterThan(0);
});

test.each(["allOf", "oneOf", "anyOf"])("cyclic %s without a value-path step fails explicitly", (keyword) => {
    const schema = { [keyword]: [{ $ref: "#/Schema" }] };
    expect(() => validateExampleValue({}, { node: schema, pointer: "#/Schema" }, { Schema: schema }, new Map(), options))
        .toThrow("Cyclic schema composition");
});

test("composition recursion through a property is valid for finite example values", () => {
    const schema = { allOf: [{ type: "object", properties: { id: { type: "integer" }, child: { $ref: "#/Schema" } } }] };
    expect(validateExampleValue({ id: 1, child: { id: 2 } }, { node: schema, pointer: "#/Schema" }, { Schema: schema }, new Map(), options)).toEqual([]);
});

test("additionalProperties explicitly permits maps and validates their values", () => {
    expect(issues({ dynamic: "value" }, { type: "object", additionalProperties: true })).toEqual([]);
    expect(issues({ dynamic: "value" }, { type: "object", additionalProperties: { type: "string" } })).toEqual([]);
    expect(issues({ dynamic: 1 }, { type: "object", additionalProperties: { type: "string" } }))
        .toMatchObject([{ code: "type", path: ["dynamic"] }]);
    expect(issues({ dynamic: 1 }, { type: "object", additionalProperties: false }))
        .toMatchObject([{ code: "undefined", path: ["dynamic"] }]);
});

test("readOnly/writeOnly required fields follow request/response direction", () => {
    const schema = { type: "object", required: ["id", "secret"], properties: {
        id: { type: "integer", readOnly: true }, secret: { type: "string", writeOnly: true },
    } };
    expect(issues({ secret: "sample" }, schema)).toEqual([]);
    expect(issues({ id: 1 }, schema, { direction: "response" })).toEqual([]);
});

test("nullable and enum constraints are both honored, including object enum key order", () => {
    expect(issues(null, { type: "string", nullable: true })).toEqual([]);
    expect(issues(null, { type: "string", nullable: true, enum: ["a"] })).toMatchObject([{ code: "enum" }]);
    expect(issues({ a: 1, b: 2 }, { type: "object", additionalProperties: true, enum: [{ b: 2, a: 1 }] })).toEqual([]);
});

test.each(["serializedWhenStructured", "value"] as const)("JSON string mode %s preserves the original value", (mode) => {
    const value = '{"name":"sample"}';
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const operation = { requestBody: { content: { "application/json": { schema, example: value } } } };
    const document = { openapi: "3.0.3" };
    const examples = collectRequestExamples(operation, {}, document, {});
    const problems = validateRequestExamples(operation, {}, examples, document, new Map(), config.requestValidation, { ...config, jsonStringMode: mode });
    expect(problems.length).toBe(mode === "serializedWhenStructured" ? 0 : 1);
    expect(examples[0].value).toBe(value);
});

test.each(["application/json", "application/problem+json", "application/vnd.example+json"])(
    "malformed serialized %s fails without YAML fallback", (mediaType) => {
        const operation = { responses: { "200": { content: { [mediaType]: { schema: { type: "object" }, example: '{"broken":}' } } } } };
        const document = { openapi: "3.0.3" };
        const examples = collectResponseExamples(operation, ["200"], document, {});
        expect(validateResponseExamples(operation, examples, ["200"], document, new Map(), config))
            .toEqual([expect.stringContaining("malformed JSON")]);
    },
);

test("JSON media with a string schema does not parse the string as JSON", () => {
    const operation = { responses: { "200": { content: { "application/json": { schema: { type: "string" }, example: "not JSON text" } } } } };
    const document = { openapi: "3.0.3" };
    expect(validateResponseExamples(operation, collectResponseExamples(operation, ["200"], document, {}), ["200"], document, new Map(), config)).toEqual([]);
});

test("unknown/non-JSON media does not silently decode structured strings", () => {
    for (const produces of [undefined, ["text/plain"]]) {
        const document = { swagger: "2.0", ...(produces ? { produces } : {}) };
        const operation = { responses: { "200": { schema: { type: "object", example: '{"name":"sample"}' } } } };
        const examples = collectResponseExamples(operation, ["200"], document, {});
        expect(validateResponseExamples(operation, examples, ["200"], document, new Map(), config))
            .toEqual([expect.stringContaining("cannot be checked without a supported JSON media")]);
    }
});

test("each response example is checked against its own media schema", () => {
    const operation = { responses: { "200": { content: {
        "application/json": { schema: { type: "object", properties: { json: { type: "integer" } } }, example: { json: 1 } },
        "application/problem+json": { schema: { type: "object", properties: { problem: { type: "boolean" } } }, example: { problem: true } },
    } } } };
    const document = { openapi: "3.0.3" };
    expect(validateResponseExamples(operation, collectResponseExamples(operation, ["200"], document, {}), ["200"], document, new Map(), config)).toEqual([]);
});

test("each request example is checked against its own media schema", () => {
    const operation = { requestBody: { content: {
        "application/json": { schema: { type: "object", properties: { json: { type: "integer" } } }, example: { json: 1 } },
        "application/problem+json": { schema: { type: "object", properties: { problem: { type: "boolean" } } }, example: { problem: true } },
    } } };
    const document = { openapi: "3.0.3" };
    expect(validateRequestExamples(operation, {}, collectRequestExamples(operation, {}, document, {}), document, new Map(), config.requestValidation, config)).toEqual([]);
});

test("request required-body checks can be disabled without disabling type and undefined checks", () => {
    const operation = { requestBody: { content: { "application/json": {
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, count: { type: "integer" } } },
        example: { count: "bad", extra: 1 },
    } } } };
    const document = { openapi: "3.0.3" };
    const examples = collectRequestExamples(operation, {}, document, {});
    const problems = validateRequestExamples(operation, {}, examples, document, new Map(), {
        ...config.requestValidation, requireRequiredBodyFields: false,
    }, config);
    expect(problems).toHaveLength(2);
    expect(problems.some((message) => message.includes("missing required"))).toBe(false);
    expect(problems.some((message) => message.includes("Expected integer"))).toBe(true);
    expect(problems.some((message) => message.includes("not defined"))).toBe(true);
});

test("response compatibility and undefined fields remain independently configurable", () => {
    const operation = { responses: { "200": { content: { "application/json": {
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, count: { type: "integer" } } },
        example: { count: "bad", extra: 1 },
    } } } } };
    const document = { openapi: "3.0.3" };
    const examples = collectResponseExamples(operation, ["200"], document, {});
    expect(validateResponseExamples(operation, examples, ["200"], document, new Map(), {
        ...config, responseValidation: { validateAgainstResponseSchema: false, forbidUndefinedFields: true },
    })).toEqual([expect.stringContaining("not defined")]);
    const problems = validateResponseExamples(operation, examples, ["200"], document, new Map(), {
        ...config, responseValidation: { validateAgainstResponseSchema: true, forbidUndefinedFields: false },
    });
    expect(problems).toHaveLength(2);
    expect(problems.some((message) => message.includes("missing required"))).toBe(true);
    expect(problems.some((message) => message.includes("Expected integer"))).toBe(true);
});

test("required/undefined checks are independently configurable and missing schema is not PASS", () => {
    expect(issues({ extra: 1 }, { type: "object", required: ["missing"] }, { checkRequired: false, forbidUndefined: false })).toEqual([]);
    const operation = { responses: { "200": { content: { "application/json": { example: {} } } } } };
    const document = { openapi: "3.0.3" };
    const examples = collectResponseExamples(operation, ["200"], document, {});
    expect(validateResponseExamples(operation, examples, ["200"], document, new Map(), config))
        .toEqual([expect.stringContaining("no response schema")]);
    expect(validateResponseExamples(operation, examples, ["200"], document, new Map(), {
        responseValidation: { validateAgainstResponseSchema: false, forbidUndefinedFields: false },
    })).toEqual([]);
});

test("selected operation parameter definitions retain native type/required/undefined checks", () => {
    const operation = { parameters: [{ name: "limit", in: "query", required: true, type: "integer" }] };
    const cfg = { includeRequestBodySchema: false, includeOperationParameters: { query: true }, forbidUndefinedFields: true };
    expect(validateRequestExamples(operation, {}, [{ source: "explicit", value: { limit: "bad", extra: 1 } }], { swagger: "2.0" }, new Map(), cfg))
        .toHaveLength(2);
    expect(validateRequestExamples(operation, {}, [{ source: "explicit", value: {} }], { swagger: "2.0" }, new Map(), cfg))
        .toEqual(["Request example is missing required operation parameter 'limit'."]);
});

test("non-JSON and cyclic examples fail explicitly, not by infinite recursion", () => {
    for (const value of [undefined, NaN, Infinity, new Date(0)]) expect(() => assertJsonExample(value, "#/example")).toThrow();
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => assertJsonExample(value, "#/example")).toThrow("Cyclic example");
});
