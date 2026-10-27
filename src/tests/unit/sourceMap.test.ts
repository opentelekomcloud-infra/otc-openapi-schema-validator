import * as yaml from "js-yaml";
import {
    diagnosticLineNumber, nativeSourceMap, objectRange, OpenApiSourceMap, operationRange,
    pathRange, sourceLineNumber, sourceMap, type SourceLocation,
} from "@/lib/openapi/sourceMap";
import { appendPointer, jsonPointer, NativeReferenceError, resolveReferenceNode } from "@/lib/openapi/references";
import { collectSchemaPaths, type SchemaFieldSource } from "@/utils/schema";
import { parseNativeOpenApi } from "@/lib/openapi/parseNativeOpenApi";
import { findMethodParametersPositionInYaml, findParameterPositionInYaml } from "@/utils/pos";
import { findInfoVersionPosition } from "@/utils/spec";

function exact(content: string, location: SourceLocation, token: string, from: number) {
    expect(location).toMatchObject({ from, to: from + token.length, lineNumber: content.slice(0, from).split(/\r\n|\r|\n/).length });
    expect(content.slice(location.from, location.to)).toBe(token);
    expect(location.from).toBeGreaterThanOrEqual(0);
    expect(location.to).toBeLessThanOrEqual(content.length);
}

beforeEach(() => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No source-map network access."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe.each(["swagger: '2.0'", "openapi: 3.0.3"])("%s original source", (version) => {
    test.each(["\n", "\r\n", "\r"])("quoted path/method keys and repeated values use exact offsets with %j", (newline) => {
        const content = [
            version, "info:", "  description: '/first get /second get'", "paths:",
            "  '/first':", "    get: {responses: {}}", "  '/second':", "    'get': {responses: {}}",
        ].join(newline);
        exact(content, operationRange(content, "/second", "get"), "'get'", content.lastIndexOf("'get'"));
        exact(content, pathRange(content, "/second"), "'/second'", content.lastIndexOf("'/second'"));
    });

    test("missing methods and parameters never leak into the next path", () => {
        const content = `${version}\npaths:\n  /first:\n    get:\n      responses: {}\n  /second:\n    post:\n      parameters:\n        - {in: query, name: limit}\n`;
        const source = sourceMap(content);
        const missingMethod = operationRange(content, "/first", "post");
        expect(missingMethod.fallback).toBe("missing");
        exact(content, missingMethod, "/first", content.indexOf("/first"));
        const params = findMethodParametersPositionInYaml(content, "/first", "get");
        expect(params).toEqual({ start: content.indexOf("get:"), end: content.indexOf("get:") + 3 });
        const missingParam = findParameterPositionInYaml(content, "/first", "get", "limit");
        expect(missingParam).toEqual(params);
        expect(source.locate("#/paths/~1missing/get").pointer).toBe("#/paths");
    });

    test("original native parser AST can be reused without changing document/text", () => {
        const content = `${version}\npaths: {"/escaped~/{id}": {get: {responses: {}}}}\n`;
        const context = parseNativeOpenApi(content);
        const before = JSON.stringify(context.document);
        exact(content, nativeSourceMap(context).locate(jsonPointer(["paths", "/escaped~/{id}", "get"])), "get", content.indexOf("get"));
        expect(context.originalContent).toBe(content);
        expect(JSON.stringify(context.document)).toBe(before);
    });
});

test.each(["swagger", "openapi"])("one-line JSON %s and escaped Unicode keys retain raw token ranges", (key) => {
    const content = `{"${key}":"${key === "swagger" ? "2.0" : "3.0.3"}","info":{"description":"/caf\\u00e9 get"},"paths":{"/caf\\u00e9":{"get":{"responses":{}}}}}`;
    exact(content, pathRange(content, "/café"), '"/caf\\u00e9"', content.lastIndexOf('"/caf\\u00e9"'));
    exact(content, operationRange(content, "/café", "get"), '"get"', content.lastIndexOf('"get"'));
});

test("RFC6901 and URI-fragment escaping distinguish slash, tilde, percent and empty keys", () => {
    const content = '{"x":{"a/b":{"~%":{"":{"value":5}}}}}';
    const pointer = jsonPointer(["x", "a/b", "~%", "", "value"]);
    exact(content, sourceMap(content).locate(pointer), '"value"', content.indexOf('"value"'));
    exact(content, sourceMap(content).locate(pointer, "value"), "5", content.indexOf("5"));
});

test("info.version never matches a nested unrelated version or a repeated description value", () => {
    const content = 'openapi: 3.0.3\ninfo:\n  title: v1\n  version: "v1"\nx-other:\n  version: wrong\n';
    expect(findInfoVersionPosition(content)).toEqual({ start: content.indexOf('"v1"'), end: content.indexOf('"v1"') + 4 });
    const missing = 'openapi: 3.0.3\ninfo: {title: sample}\nx-other: {version: wrong}\n';
    expect(findInfoVersionPosition(missing)).toEqual({ start: missing.indexOf("info:"), end: missing.indexOf("info:") + 4 });
});

test("inherited/reusable parameters highlight their actual name value; overrides keep their own source", () => {
    const content = `swagger: "2.0"
parameters:
  Shared: {in: query, name: "limit", type: integer}
paths:
  /first:
    parameters: [{$ref: "#/parameters/Shared"}]
    get: {}
    post:
      parameters: [{in: query, name: limit, type: integer}]
`;
    const source = sourceMap(content);
    exact(content, source.parameter("/first", "get", "limit", "query"), '"limit"', content.indexOf('"limit"'));
    exact(content, source.parameter("/first", "post", "limit", "query"), "limit", content.lastIndexOf("name: limit") + 6);
});

test("Swagger body locates its inherited declaration rather than a nonexistent requestBody", () => {
    const content = 'swagger: "2.0"\nparameters:\n  Body: {in: body, name: payload, schema: {type: object}}\npaths:\n  /first:\n    parameters: [{$ref: "#/parameters/Body"}]\n    post: {}\n';
    const token = "{in: body, name: payload, schema: {type: object}}";
    exact(content, sourceMap(content).requestBody("/first", "post"), token, content.indexOf(token));
});

test("Path Item, response and schema refs map to concrete declarations", () => {
    const content = `openapi: 3.0.3
paths: {/first: {$ref: "#/x-paths/A"}}
x-paths:
  A: {get: {responses: {"200": {$ref: "#/components/responses/A"}}}}
components:
  responses:
    A: {content: {application/json: {schema: {$ref: "#/components/schemas/A"}}}}
  schemas:
    A: {type: object, properties: {id: {type: integer}}}
`;
    exact(content, operationRange(content, "/first", "get"), "get", content.indexOf("get:"));
    const pointer = jsonPointer(["paths", "/first", "get", "responses", "200", "content", "application/json", "schema", "properties", "id"]);
    exact(content, sourceMap(content).locate(pointer, "key", true), "id", content.indexOf("id:"));
});

test.each(["external.yaml#/A", "#/missing", "#bad", "#/%xx", "#/x-loop"])("unavailable ref %s locates the authored reference without fetching", (ref) => {
    const content = `openapi: 3.0.3\npaths: {/first: {$ref: "${ref}"}}\nx-loop: {$ref: "#/x-loop"}\n`;
    const location = operationRange(content, "/first", "get");
    expect(location.fallback).toBe("unresolved-reference");
    expect(content.slice(location.from, location.to)).toBe("$ref");
});

test("reference targets must be real pointers, not virtual paths through another ref", () => {
    const content = 'x: {A: {$ref: "#/x/B"}, B: {id: 1}, C: {$ref: "#/x/A/id"}}';
    expect(sourceMap(content).locate("#/x/C", "value", true).fallback).toBe("unresolved-reference");
});

test("long ref chains are bounded by source size, not JavaScript call-stack depth", () => {
    const nodes = Object.fromEntries(Array.from({ length: 2000 }, (_, index) =>
        [String(index), index === 1999 ? { name: "final" } : { $ref: `#/x/${index + 1}` }]));
    const content = JSON.stringify({ x: nodes });
    const location = sourceMap(content).locate("#/x/0/name", "value", true);
    exact(content, location, '"final"', content.indexOf('"final"'));
});

test("YAML aliases and merge precedence retain actual declaration ranges", () => {
    const content = `openapi: 3.0.3
x-base: &base
  get: {responses: {}}
x-other: &other
  get: {responses: {"200": {description: ignored}}}
paths:
  /alias: *base
  /merged:
    <<: [*base, *other]
  /override:
    <<: *base
    get: {responses: {"201": {description: own}}}
  /inline:
    <<: {get: {responses: {}}}
`;
    for (const path of ["/alias", "/merged"]) exact(content, operationRange(content, path, "get"), "get", content.indexOf("get:"));
    exact(content, operationRange(content, "/override", "get"), "get", content.indexOf('get: {responses: {"201"'));
    exact(content, operationRange(content, "/inline", "get"), "get", content.lastIndexOf("get:"));
});

test("example $ref is literal unless the caller explicitly requests contract dereferencing", () => {
    const content = 'x: {example: {$ref: "literal", name: sample}}';
    exact(content, sourceMap(content).locate("#/x/example/$ref", "value"), '"literal"', content.indexOf('"literal"'));
});

test("runtime object identity maps repeated schema fields without name-based guesses", () => {
    const content = 'openapi: 3.0.3\ncomponents:\n  schemas:\n    A: {properties: {created: {type: string}}}\n    B: {properties: {created: {type: integer}}}\n';
    const document = yaml.load(content) as { components: { schemas: { B: { properties: object } } } };
    exact(content, objectRange(document, content, document.components.schemas.B.properties, "created"), "created", content.lastIndexOf("created:"));
});

test("same object identity with edited content is reindexed rather than using stale positions", () => {
    const document = { x: { field: {} } };
    const first = '{"x":{"field":{}}}';
    const second = '{ "padding":0, "x": { "field": {} } }';
    exact(first, objectRange(document, first, document.x, "field"), '"field"', first.indexOf('"field"'));
    exact(second, objectRange(document, second, document.x, "field"), '"field"', second.indexOf('"field"'));
    sourceMap("x: 1");
    sourceMap("x: 2");
    exact(first, objectRange(document, first, document.x, "field"), '"field"', first.indexOf('"field"'));
});

test("legacy Map node identities map to their own original properties", () => {
    const properties = new Map([["id", { type: "integer" }]]);
    const document = new Map([["properties", properties]]);
    const content = '{"properties":{"id":{"type":"integer"}}}';
    exact(content, objectRange(document, content, properties, "id"), '"id"', content.indexOf('"id"'));
});

test("overwritten declarations use the effective parent; missing/invalid/empty source retains fallbacks", () => {
    const duplicate = "paths:\n  /first: {get: {}}\n  /first: {post: {}}\n";
    expect(operationRange(duplicate, "/first", "get").fallback).toBe("missing");
    exact(duplicate, operationRange(duplicate, "/first", "get"), "/first", duplicate.lastIndexOf("/first"));
    expect(sourceMap("paths: [").locate("#/paths/get").fallback).toBe("invalid-source");
    expect(sourceMap("").locate("#/paths/get")).toMatchObject({ from: 0, to: 0, lineNumber: 1, fallback: "missing" });
    const noValue = "info:\n  version:\n";
    exact(noValue, sourceMap(noValue).locate("#/info/version", "value"), "version", noValue.indexOf("version"));
    const nullable = "parameters: [null]\n";
    expect(sourceMap(nullable).locate("#/parameters/0/name").fallback).toBe("missing");
});

test("line reporting uses original UTF-16 offsets, CRLF/CR/LF and valid EOF positions", () => {
    const content = "😀\r\nsecond\rthird\n";
    expect(sourceLineNumber(content, 0)).toBe(1);
    expect(sourceLineNumber(content, 4)).toBe(2);
    expect(sourceLineNumber(content, 11)).toBe(3);
    expect(sourceLineNumber(content, content.length)).toBe(4);
    expect(diagnosticLineNumber(content, { from: 4, lineNumber: 99 })).toBe(2);
    expect(diagnosticLineNumber(undefined, { from: 100 })).toBe("N/A");
    expect(diagnosticLineNumber(undefined, { lineNumber: 7 })).toBe(7);
    expect(diagnosticLineNumber("", { from: 0 })).toBe(1);
    for (const offset of [-1, content.length + 1, NaN, 0.5]) expect(() => sourceLineNumber(content, offset)).toThrow(RangeError);
});

test("canonical pointers can be extended without lossy dot/bracket conversions", () => {
    const pointer = appendPointer(jsonPointer(["x.a"]), "[0]/~", "");
    expect(sourceMap('{"x.a":{"[0]/~":{"":7}}}').scalar(pointer)).toBe(7);
    expect(new OpenApiSourceMap("root: {value: 2}").scalar("#/root/value")).toBe(2);
});

test("field-source metadata preserves schema traversal results and original owner identity", () => {
    const child = { type: "object", properties: { badName: { type: "string" } } };
    const document = { Child: child };
    const schema = { allOf: [{ properties: { items: { type: "array", items: { $ref: "#/Child" } } } }, { properties: { other: { $ref: "#/Child" } } }] };
    const sources = new Map<string, SchemaFieldSource>();
    const before = JSON.stringify({ schema, document });
    const legacy = collectSchemaPaths(schema, document, new Map());
    const mapped = collectSchemaPaths(schema, document, new Map(), "", new Set(), sources);
    expect(mapped).toEqual(legacy);
    expect(sources.get("items[].badName")?.owner).toBe(child.properties);
    expect(sources.get("items[].badName")?.key).toBe("badName");
    expect(JSON.stringify({ schema, document })).toBe(before);
});

test("reference error origin metadata is non-enumerable and does not serialize document nodes", () => {
    const node = { $ref: "#/missing" };
    let error: unknown;
    try {
        resolveReferenceNode(node, {});
    } catch (caught) {
        error = caught;
    }
    if (!(error instanceof NativeReferenceError)) throw new Error("Expected a native reference error");
    expect(error.sourceNode).toBe(node);
    expect(Object.keys(error)).not.toContain("sourceNode");
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("sourceNode");
});
