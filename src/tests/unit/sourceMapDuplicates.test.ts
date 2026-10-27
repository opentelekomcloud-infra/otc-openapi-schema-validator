import * as yaml from "js-yaml";
import { parseDocument } from "yaml";
import {
    objectRange, OpenApiSourceMap, operationRange, sourceLineNumber, sourceMap, type SourceLocation,
} from "@/lib/openapi/sourceMap";
import { appendPointer, jsonPointer } from "@/lib/openapi/references";

function exact(content: string, location: SourceLocation, token: string, start: number) {
    expect(location).toMatchObject({ from: start, to: start + token.length, lineNumber: sourceLineNumber(content, start) });
    expect(content.slice(location.from, location.to)).toBe(token);
    expect(location.fallback).toBeUndefined();
}

beforeEach(() => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Coordinate mapping must remain offline."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe.each(["swagger: '2.0'", "openapi: 3.0.3"])("%s effective source", (version) => {
    test.each(["\n", "\r\n", "\r"])("repeated methods map to their last own declaration with %j", (newline) => {
        const content = [
            version, "paths:", '  "/v1/😀~/{id}":',
            "    get: {parameters: [{in: query, name: obsolete}]}",
            "    post: {}", "    get: {parameters: [{in: query, name: retained}]}",
            "    post: {responses: {}}", "  /v1/other:", "    get: {}",
        ].join(newline);
        const path = "/v1/😀~/{id}";
        exact(content, operationRange(content, path, "get"), "get", content.indexOf("get: {parameters: [{in: query, name: retained}]}"));
        exact(content, operationRange(content, path, "post"), "post", content.indexOf("post: {responses: {}}"));
        exact(content, sourceMap(content).parameter(path, "get", "retained", "query"), "retained", content.indexOf("retained"));
        const missing = sourceMap(content).parameter(path, "get", "obsolete", "query");
        expect(missing.fallback).toBe("missing");
        expect(missing.from).toBe(content.indexOf("get: {parameters: [{in: query, name: retained}]}"));
        expect(sourceMap(content).entries(jsonPointer(["paths", path])).map(({ key }) => key)).toEqual(["get", "post"]);
    });

    test.each(["block", "flow", "json"])("%s overwrites an entire Path Item, not individual old methods", (format) => {
        const marker = version.startsWith("swagger") ? '"swagger":"2.0"' : '"openapi":"3.0.3"';
        const content = format === "json"
            ? `{${marker},"paths":{"/first":{"get":{}},"/first":{"post":{}},"/second":{"get":{}}}}`
            : format === "flow"
                ? `${version}\npaths: {"/first": {get: {}}, "/first": {post: {}}, /second: {get: {}}}`
                : `${version}\npaths:\n  "/first": {get: {}}\n  "/first": {post: {}}\n  /second: {get: {}}`;
        const source = sourceMap(content);
        const token = format === "json" ? '"post"' : "post";
        exact(content, operationRange(content, "/first", "post"), token, content.indexOf(token));
        const missing = operationRange(content, "/first", "get");
        expect(missing).toMatchObject({ fallback: "missing", from: content.lastIndexOf('"/first"') });
        expect(source.entries("#/paths").map(({ key }) => key)).toEqual(["/first", "/second"]);
        expect(source.entries("#/paths/~1first").map(({ key }) => key)).toEqual(["post"]);
    });

    test("preserves old anchors reached through aliases when their authored mapping key is overwritten", () => {
        const body = version.startsWith("swagger")
            ? "      - {name: payload, in: body, schema: {type: object}}\n"
            : "    requestBody: {content: {application/json: {schema: {type: object}}}}\n";
        const content = `${version}
x-item: &old
  post:
    parameters:
      - {name: "old_name", in: query}
${body}x-item:
  post:
    parameters:
      - {name: new_name, in: query}
paths:
  /old: *old
  /current: {$ref: "#/x-item"}
`;
        const source = sourceMap(content);
        const pointer = "#/paths/~1old/post/parameters";
        const entries = source.entries(pointer, true);
        expect(entries[0].pointer).toBe(`${pointer}/0`);
        expect(source.scalar(appendPointer(entries[0].pointer, "name"), true)).toBe("old_name");
        exact(content, source.parameter("/old", "post", "old_name", "query"), '"old_name"', content.indexOf('"old_name"'));
        const aliasLocation = source.locate(appendPointer(entries[0].pointer, "name"), "value", true);
        expect(aliasLocation.pointer).toBe("#/paths/~1old/post/parameters/0/name");
        expect(source.locate(aliasLocation.pointer, "value", true)).toEqual(aliasLocation);
        exact(content, source.parameter("/current", "post", "new_name", "query"), "new_name", content.indexOf("new_name"));
        if (version.startsWith("swagger")) {
            const token = "{name: payload, in: body, schema: {type: object}}";
            exact(content, source.requestBody("/old", "post"), token, content.indexOf(token));
        } else {
            exact(content, source.requestBody("/old", "post"), "requestBody", content.indexOf("requestBody:"));
        }
        const parsed = yaml.load(content, { json: true }) as { paths: { "/old": { post: { parameters: object[] } } } };
        exact(content, objectRange(parsed, content, parsed.paths["/old"].post.parameters[0], "name", "value"), '"old_name"', content.indexOf('"old_name"'));
    });

    test("follows local refs to the last response/schema declarations and actual property nodes", () => {
        const content = `${version}
paths: {/first: {$ref: "#/x-items/A"}}
x-items:
  A: {get: {responses: {"200": {$ref: "#/x-responses/A"}}}}
x-responses:
  A: {schema: {properties: {obsolete: {type: string}}}}
  A: {schema: {$ref: "#/x-schemas/A"}}
x-schemas:
  A: {properties: {id: {type: integer}}}
  A: {properties: {"id": {type: string}}}
`;
        const source = sourceMap(content);
        const pointer = "#/paths/~1first/get/responses/200/schema/properties/id";
        exact(content, source.locate(pointer, "key", true), '"id"', content.indexOf('"id"'));
        expect(source.locate(pointer, "key", true).pointer).toBe("#/x-schemas/A/properties/id");
        expect(source.scalar(appendPointer(pointer, "type"), true)).toBe("string");
        expect(source.entries("#/x-responses").map(({ key }) => key)).toEqual(["A"]);
        const missing = source.locate("#/paths/~1first/get/responses/200/schema/properties/obsolete", "key", true);
        expect(missing.fallback).toBe("missing");
        expect(content.slice(missing.from, missing.to)).toBe("properties");
    });
});

test("own entries retain runtime order and last values without changing existing merge lookup precedence", () => {
    const content = `x-base: &base {b: base, a: base, "10": ten}
x-other: &other {b: other, "2": two}
x-object:
  <<: [*base, *other]
  "10": ten
  a: first
  "2": two
  a: last
  own: end
`;
    const parsed = yaml.load(content, { json: true }) as { "x-object": Record<string, string> };
    const source = sourceMap(content);
    const entries = source.entries("#/x-object");
    const ownKeys = Object.keys(parsed["x-object"]).filter((key) => key !== "<<");
    expect(entries.map(({ key }) => key)).toEqual(ownKeys);
    expect(entries.map(({ pointer }) => source.scalar(pointer))).toEqual(ownKeys.map((key) => parsed["x-object"][key]));
    expect(source.scalar("#/x-object/b")).toBe("base");
    expect(source.scalar("#/x-object/a")).toBe("last");
    const merged = source.locate("#/x-object/b", "value");
    expect(merged.pointer).toBe("#/x-object/b");
    expect(source.locate(merged.pointer, "value")).toEqual(merged);
    expect(entries.map(({ key }) => key)).toEqual(["2", "10", "a", "own"]);
});

test("a unique bare-key candidate uses its actual node, not an overwritten authored pointer", () => {
    const content = 'x: &old {unique_field: value}\nx: {}\ny: *old\n';
    const source = sourceMap(content);
    exact(content, source.findKey("unique_field"), "unique_field", content.indexOf("unique_field"));
    exact(content, source.locate("#/y/unique_field"), "unique_field", content.indexOf("unique_field"));
    expect(source.scalar("#/x/unique_field")).toBeUndefined();
    expect(source.entries("#/y")).toEqual([{ key: "unique_field", pointer: "#/y/unique_field" }]);
    expect(source.scalar(source.entries("#/y")[0].pointer)).toBe("value");
});

test("bare-key lookup never guesses between different mappings, even with effective duplicate handling", () => {
    const content = "x: {id: 1}\ny: {id: 2}\n";
    expect(sourceMap(content).findKey("id").fallback).toBe("ambiguous");
    expect(sourceMap("x: {unique: 1").findKey("unique").fallback).toBe("invalid-source");
    const quoted = '{"x":{"get":1,"g\\u0065t":2}}';
    exact(quoted, sourceMap(quoted).locate("#/x/get"), '"g\\u0065t"', quoted.indexOf('"g\\u0065t"'));
    expect(sourceMap(quoted).scalar("#/x/get")).toBe(2);
});

test("source AST and raw duplicate-method audit retain overwritten nodes and original ranges", () => {
    const content = "paths:\n  /first:\n    get: {}\n    get: {}\n";
    const ast = parseDocument(content, { uniqueKeys: false, keepSourceTokens: true, merge: true });
    const before = ast.toString();
    const source = new OpenApiSourceMap(content, ast);
    exact(content, source.locate("#/paths/~1first/get"), "get", content.lastIndexOf("get:"));
    expect(source.entries("#/paths/~1first")).toHaveLength(1);
    expect(source.duplicateMethods()[0].methods).toEqual([{ method: "get", lines: [3, 4] }]);
    expect(ast.toString()).toBe(before);
    expect(source.content).toBe(content);
});

test("self-referencing merges do not change own-key enumeration or make it recurse", () => {
    const content = "x: &self {<<: *self, own: retained}\n";
    expect(sourceMap(content).entries("#/x")).toEqual([{ key: "own", pointer: "#/x/own" }]);
    expect(sourceMap(content).scalar("#/x/own")).toBe("retained");
});
