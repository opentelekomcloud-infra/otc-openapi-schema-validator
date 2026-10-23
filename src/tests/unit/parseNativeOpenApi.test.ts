import { isAlias, isMap, isScalar, YAMLParseError } from "yaml";
import {
    classifyNativeOpenApiDocument, isOpenApi30Document, isOpenApi30Version, isSwagger2Document,
    parseNativeOpenApi, type NativeParseOptions,
} from "@/lib/openapi/parseNativeOpenApi";
import { NativeOpenApiError, type NativeOpenApiErrorCode } from "@/lib/openapi/documentError";
import type { OpenApi30Document, Swagger2Document } from "@/types/openapi";
import { readFixture, readFixtureContent, type Dialect } from "../fixtures/dual-version/scenarios";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native parsing must not invoke the converter."); }),
    convertObj: jest.fn(() => { throw new Error("Native parsing must not invoke the converter."); }),
}));

const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native parsing must not access the network."));
});

afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function expectError(
    content: unknown, code: NativeOpenApiErrorCode, options?: NativeParseOptions
): NativeOpenApiError {
    try {
        parseNativeOpenApi(content, options);
    } catch (error: unknown) {
        if (!(error instanceof NativeOpenApiError)) throw error;
        expect(error.code).toBe(code);
        expect(error.statusCode).toBe(400);
        expect(error.range.from).toBeGreaterThanOrEqual(0);
        expect(error.range.to).toBeGreaterThanOrEqual(error.range.from);
        expect(error.range.to).toBeLessThanOrEqual(typeof content === "string" ? content.length : 0);
        expect(error.toDiagnostic()).toEqual({
            ...error.range, severity: "error", source: error.source, message: error.message,
        });
        return error;
    }
    throw new Error(`Expected ${code}, but parsing succeeded.`);
}

describe("native format classification and type guards", () => {
    test.each(["2.0", 2] as const)("classifies Swagger %s without changing the input object", (swagger) => {
        const definitions = Object.freeze({ Resource: Object.freeze({ type: "object" }) });
        const input = Object.freeze({
            swagger, info: Object.freeze({ version: "v2" }), paths: Object.freeze({}), definitions,
        });
        const result = classifyNativeOpenApiDocument(input);
        expect(result).toEqual({ dialect: "swagger2", formatVersion: "2.0", document: input });
        expect(result.document).toBe(input);
        expect(result.document.definitions).toBe(definitions);
        expect(result.document.swagger).toBe(swagger);
        if (result.dialect !== "swagger2") throw new Error("Expected Swagger context narrowing.");
        const narrowed: Swagger2Document = result.document;
        expect(narrowed.swagger).toBe(swagger);
        expect(isSwagger2Document(input)).toBe(true);
        expect(isOpenApi30Document(input)).toBe(false);
    });

    test.each(["3.0.0", "3.0.3", "3.0.10"])("classifies OpenAPI %s independently of info.version", (openapi) => {
        const input = Object.freeze({ openapi, info: Object.freeze({ version: "v2" }), paths: Object.freeze({}) });
        const result = classifyNativeOpenApiDocument(input);
        expect(result.document).toBe(input);
        expect(result.formatVersion).toBe(openapi);
        if (result.dialect !== "openapi3") throw new Error("Expected OpenAPI context narrowing.");
        const narrowed: OpenApi30Document = result.document;
        expect(narrowed.openapi).toBe(openapi);
        expect(isSwagger2Document(input)).toBe(false);
        expect(isOpenApi30Document(input)).toBe(true);
    });

    test.each([null, undefined, [], "swagger: 2.0", 2, new Map(), new Date()])(
        "does not treat a non-mapping value as a document: %p", (value) => {
            expect(isSwagger2Document(value)).toBe(false);
            expect(isOpenApi30Document(value)).toBe(false);
            expect(() => classifyNativeOpenApiDocument(value)).toThrow(NativeOpenApiError);
        }
    );

    test.each(["3.0", "3.1.1", "3.2.0", "4.0.0", "3.0.invalid", "3.0.1-extra", " 3.0.3",
        "3.0.3 ", "3.0.3\n", "3.0.3\r\n", "3.0.3\u2028", 3, null])(
        "does not qualify unsupported or malformed OAS versions: %p", (version) => {
            expect(isOpenApi30Version(version)).toBe(false);
            expect(isOpenApi30Document({ openapi: version })).toBe(false);
        }
    );

    test("rejects both markers even when one has an undefined value", () => {
        const input = { swagger: "2.0", openapi: undefined };
        expect(isSwagger2Document(input)).toBe(false);
        expect(isOpenApi30Document(input)).toBe(false);
        expect(() => classifyNativeOpenApiDocument(input)).toThrow("not both");
    });

    test("does not infer the format from info.version", () => {
        expect(() => classifyNativeOpenApiDocument({ info: { version: "v2" }, paths: {} }))
            .toThrow("Missing 'swagger' or 'openapi'");
    });

    test("leaves required root fields and container schemas to the rules", () => {
        expect(classifyNativeOpenApiDocument({ swagger: "2.0" }).dialect).toBe("swagger2");
        expect(classifyNativeOpenApiDocument({ openapi: "3.0.3", paths: null }).dialect).toBe("openapi3");
    });
});

describe.each(["swagger2", "openapi3"] satisfies Dialect[])("%s original source context", (dialect) => {
    test.each(["", "-form-data", "-reusables", "-inheritance"])(
        "retains native nodes, values and exact YAML bytes for fixture %s", (suffix) => {
            const content = readFixtureContent(dialect, suffix);
            const context = parseNativeOpenApi(content);
            expect(context.dialect).toBe(dialect);
            expect(context.originalContent).toBe(content);
            expect(context.sourceFormat).toBe("yaml");
            expect(context.document).toEqual(readFixture(dialect, suffix));
            expect(context.sourceDocument.errors).toEqual([]);
            expect(context.sourceDocument.warnings).toEqual([]);
            if (dialect === "swagger2") {
                expect(context.document).not.toHaveProperty("openapi");
                expect(context.document).not.toHaveProperty("components");
            } else {
                expect(context.document).not.toHaveProperty("swagger");
                expect(context.document).not.toHaveProperty("definitions");
            }
        }
    );

    test.each(["", "-form-data", "-reusables", "-inheritance"])(
        "retains JSON whitespace and native values for fixture %s", (suffix) => {
            const document = readFixture(dialect, suffix);
            const content = "\r\n  " + JSON.stringify(document, null, "\t") + "\r\n";
            const context = parseNativeOpenApi(content);
            expect(context.dialect).toBe(dialect);
            expect(context.originalContent).toBe(content);
            expect(context.sourceFormat).toBe("json");
            expect(context.document).toEqual(document);
        }
    );
});

test.each(["cfw_v1_en_test.yaml", "dc_v1_en_test.yaml", "smn_v2_en_test.yaml"])(
    "accepts the existing OAS3 functional fixture without changing its source: %s", (file) => {
        const content = fs.readFileSync(path.join(process.cwd(), "src/tests/functional/specs", file), "utf8");
        const context = parseNativeOpenApi(content);
        expect(context.dialect).toBe("openapi3");
        expect(context.formatVersion).toBe("3.0.1");
        expect(context.originalContent).toBe(content);
    }
);

test("rejects duplicate operations in the legacy ER fixture instead of silently overwriting them", () => {
    const content = fs.readFileSync(path.join(process.cwd(), "src/tests/functional/specs/er_v3_en_test.yaml"), "utf8");
    const error = expectError(content, "INVALID_SYNTAX");
    if (!(error.cause instanceof YAMLParseError)) throw new Error("Expected a YAML parse error.");
    expect(error.cause.code).toBe("DUPLICATE_KEY");
    expect(content.slice(error.range.from, error.range.from + 4)).toBe("get:");
});

describe("strict input handling", () => {
    test.each([null, undefined, 42, [], { swagger: "2.0" }])("rejects non-text input: %p", (content) => {
        expectError(content, "INVALID_INPUT");
    });

    test("rejects an invalid format option at the JavaScript boundary", () => {
        const content = 'swagger: "2.0"\n';
        // @ts-expect-error JavaScript callers can bypass the option union.
        expectError(content, "INVALID_INPUT", { format: "toml" });
        // @ts-expect-error JavaScript callers can pass a non-object option.
        expectError(content, "INVALID_INPUT", null);
    });

    test.each(["", " \r\n", "null", "true", "42", '"scalar"', "[]", "[1, 2]"])(
        "rejects a non-object document root: %p", (content) => {
            expectError(content, "INVALID_DOCUMENT");
        }
    );

    test.each([
        "swagger: [",
        'swagger: "2.0"\n  invalid indentation',
        'swagger: "2.0"\npaths: {',
        'swagger: "2.0"\nswagger: "2.0"',
        '---\nswagger: "2.0"\n---\nopenapi: 3.0.3',
        'swagger: "2.0"\nx-data: !unknown value',
        'swagger: "2.0"\nx-data: *missing',
    ])("rejects malformed/ambiguous YAML without repairing it: %p", (content) => {
        expect(expectError(content, "INVALID_SYNTAX").source).toBe("parser");
    });

    test.each([
        '{"swagger":"2.0",}',
        '{"swagger":"2.0","x-data":[1,]}',
        '{"swagger":"2.0",/* comment */"paths":{}}',
        '{"swagger":"2.0",// comment\n"paths":{}}',
        '{"swagger":"2.0","paths":{unquoted: {}}}',
        '{"swagger":"2.0","paths":',
        '{"swagger":"2.0","swagger":"2.0"}',
        "\uFEFF" + '{"swagger":"2.0"}',
    ])("rejects malformed JSON without falling back to YAML: %p", (content) => {
        expectError(content, "INVALID_SYNTAX");
    });

    test("requires an explicit YAML mode for a flow-style YAML root", () => {
        const content = '{swagger: "2.0", paths: {}}';
        expectError(content, "INVALID_SYNTAX");
        const context = parseNativeOpenApi(content, { format: "yaml" });
        expect(context.sourceFormat).toBe("yaml");
        expect(context.document).toEqual({ swagger: "2.0", paths: {} });
        expect(context.originalContent).toBe(content);
    });

    test("honors explicit formats without retrying a different parser", () => {
        expectError('swagger: "2.0"\npaths: {}\n', "INVALID_SYNTAX", { format: "json" });
        const content = '{"swagger":"2.0", "paths":{},}';
        expectError(content, "INVALID_SYNTAX", { format: "auto" });
        expect(parseNativeOpenApi(content, { format: "yaml" }).document.swagger).toBe("2.0");
    });

    test("allows legal YAML flow commas without a converter fallback", () => {
        const content = 'swagger: "2.0"\npaths: {}\nx-data: {value: 1,}\n';
        const context = parseNativeOpenApi(content);
        expect(context.originalContent).toBe(content);
        expect(context.document["x-data"]).toEqual({ value: 1 });
    });

    test.each(['swagger: "2"', 'swagger: "1.2"', 'swagger: "2.1"', "swagger: null", 'swagger: ["2.0"]',
        "openapi: 3", 'openapi: "3.0"', "openapi: 3.1.1", "openapi: 3.2.0", "openapi: null",
        "openapi: [3.0.3]"])("rejects unsupported format markers: %s", (content) => {
        const error = expectError(content + "\ninfo: {version: v2}\npaths: {}\n", "UNSUPPORTED_VERSION");
        expect(error.source).toBe("version");
    });

    test.each([
        'swagger: "2.0"\nopenapi: 3.0.3',
        'swagger: "2.0"\nopenapi: null',
        'swagger: null\nopenapi: 3.0.3',
        '{"swagger":"2.0","openapi":"3.0.3"}',
    ])("rejects conflicting declarations: %p", (content) => {
        expectError(content, "CONFLICTING_VERSIONS");
    });

    test("returns a distinct missing-version error rather than guessing from API version", () => {
        const error = expectError("info: {version: v2}\npaths: {}\n", "MISSING_VERSION");
        expect(error.source).toBe("version");
    });
});

describe("source fidelity and YAML value semantics", () => {
    test.each([["yaml", "2"], ["yaml", "2.0"], ["json", "2"], ["json", "2.0"]])(
        "retains a numeric Swagger marker in %s: %s", (format, token) => {
            const content = format === "json" ? `{"swagger":${token},"paths":{}}` : `swagger: ${token}\npaths: {}\n`;
            const context = parseNativeOpenApi(content);
            expect(context.sourceFormat).toBe(format);
            expect(context.formatVersion).toBe("2.0");
            expect(context.document.swagger).toBe(2);
            const node = context.sourceDocument.get("swagger", true);
            if (!isScalar(node) || !node.range) throw new Error("Expected original version scalar.");
            expect(content.slice(node.range[0], node.range[1])).toBe(token);
            expect(node.value).toBe(2);
        }
    );

    test("keeps comments, quotes, CRLF, extensions and original ref nodes", () => {
        const content = "# original\r\nswagger: '2.0' # marker\r\npaths: {}\r\n" +
            'definitions:\r\n  Resource:\r\n    $ref: "#/definitions/Other"\r\n' +
            "  Other: {type: object}\r\nx-note: unchanged\r\n";
        const context = parseNativeOpenApi(content);
        expect(context.originalContent).toBe(content);
        const node = context.sourceDocument.getIn(["definitions", "Resource", "$ref"], true);
        if (!isScalar(node) || !node.range) throw new Error("Expected original ref scalar.");
        expect(node.value).toBe("#/definitions/Other");
        expect(content.slice(node.range[0], node.range[1])).toBe('"#/definitions/Other"');
        expect(context.document["x-note"]).toBe("unchanged");
        expect(context.document.definitions).toEqual({
            Resource: { $ref: "#/definitions/Other" }, Other: { type: "object" },
        });
    });

    test("locates a version error at the original quoted scalar", () => {
        const content = '# before\r\nswagger: "2.1" # unsupported\r\npaths: {}\r\n';
        const error = expectError(content, "UNSUPPORTED_VERSION");
        expect(content.slice(error.range.from, error.range.to)).toBe('"2.1"');
    });

    test("locates an unsupported JSON version in the unmodified original source", () => {
        const content = ' \r\n{\r\n\t"openapi": "3.2.0",\r\n\t"paths": {}\r\n}\r\n';
        const error = expectError(content, "UNSUPPORTED_VERSION");
        expect(content.slice(error.range.from, error.range.to)).toBe('"3.2.0"');
    });

    test("supports ordinary aliases and merge keys while retaining their AST nodes", () => {
        const content = 'swagger: "2.0"\npaths: {}\ndefinitions:\n' +
            "  Base: &base\n    type: object\n    properties:\n      name: {type: string}\n" +
            "  Resource:\n    <<: *base\n    description: Resource details\n";
        const context = parseNativeOpenApi(content);
        expect(context.document.definitions).toEqual({
            Base: { type: "object", properties: { name: { type: "string" } } },
            Resource: { type: "object", properties: { name: { type: "string" } }, description: "Resource details" },
        });
        const resource = context.sourceDocument.getIn(["definitions", "Resource"], true);
        if (!isMap(resource)) throw new Error("Expected original resource mapping.");
        const merge = resource.items.find((pair) => isScalar(pair.key) && pair.key.source === "<<");
        expect(isAlias(merge?.value)).toBe(true);
        expect(context.originalContent).toBe(content);
    });

    test("supports recursive schema refs without expanding or fetching them", () => {
        const content = 'swagger: "2.0"\npaths: {}\ndefinitions:\n  Resource:\n    type: object\n' +
            '    properties:\n      child: {$ref: "#/definitions/Resource"}\n';
        expect(parseNativeOpenApi(content).document.definitions).toEqual({
            Resource: { type: "object", properties: { child: { $ref: "#/definitions/Resource" } } },
        });
    });

    test("retains external refs as authored, without introducing network resolution", () => {
        const content = 'openapi: 3.0.3\npaths: {}\ncomponents:\n  schemas:\n    Resource:\n' +
            '      $ref: "https://fixtures.example.invalid/resource.yaml#/Resource"\n';
        expect(parseNativeOpenApi(content).document.components).toEqual({
            schemas: { Resource: { $ref: "https://fixtures.example.invalid/resource.yaml#/Resource" } },
        });
    });

    test("does not coerce implicit dates or YAML 1.1 boolean-like strings", () => {
        const context = parseNativeOpenApi('swagger: "2.0"\nx-data: {date: 2026-01-01, label: on}\n');
        expect(context.document["x-data"]).toEqual({ date: "2026-01-01", label: "on" });
    });

    test("respects an explicit YAML version directive instead of reinterpreting its scalar values", () => {
        const content = '%YAML 1.1\n---\nswagger: "2.0"\nx-data: {label: on}\n';
        const context = parseNativeOpenApi(content);
        expect(context.document["x-data"]).toEqual({ label: true });
        expect(context.sourceDocument.directives.yaml.version).toBe("1.1");
        expect(context.originalContent).toBe(content);
    });

    test("retains a YAML byte-order mark and version-token offsets", () => {
        const content = '\uFEFFswagger: "2.0"\npaths: {}\n';
        const context = parseNativeOpenApi(content);
        expect(context.originalContent).toBe(content);
        const node = context.sourceDocument.get("swagger", true);
        if (!isScalar(node) || !node.range) throw new Error("Expected original version scalar.");
        expect(content.slice(node.range[0], node.range[1])).toBe('"2.0"');
    });

    test("rejects numeric/string key collisions rather than losing a response", () => {
        const content = 'swagger: "2.0"\npaths:\n  /resources:\n    get:\n      responses:\n' +
            '        200: {description: First}\n        "200": {description: Second}\n';
        expectError(content, "INVALID_SYNTAX");
    });

    test.each([".inf", "-.inf", ".nan"])("rejects a non-JSON numeric value: %s", (value) => {
        expectError(`swagger: "2.0"\nx-data: ${value}\n`, "NON_JSON_VALUE");
    });

    test("rejects JSON numbers outside the finite runtime range", () => {
        expectError('{"swagger":"2.0","x-data":1e400}', "NON_JSON_VALUE");
    });

    test("rejects complex YAML keys rather than implicitly stringifying them", () => {
        expectError('swagger: "2.0"\nx-data:\n  ? [a, b]\n  : value\n', "NON_JSON_VALUE");
    });

    test("reports cyclic aliases explicitly, while $ref recursion remains supported", () => {
        const error = expectError('swagger: "2.0"\nx-data: &loop {child: *loop}\n', "NON_JSON_VALUE");
        expect(error.message).toContain("Cyclic YAML aliases");
    });

    test.each(['&root {swagger: "2.0", <<: *root}', 'swagger: "2.0"\nx-data: &loop {<<: *loop}'])(
        "rejects cyclic merges before materializing a recursive merge: %p", (content) => {
            expect(expectError(content, "NON_JSON_VALUE").message).toContain("Cyclic YAML aliases");
        }
    );

    test.each(['swagger: "2.0"\nx-data: {<<: 3}', 'swagger: "2.0"\nx-data: {<<: [3]}'])(
        "reports invalid merge sources as explicit input errors: %p", (content) => {
            expect(expectError(content, "INVALID_SYNTAX").message).toContain("YAML merge sources");
        }
    );

    test("reports alias expansion limits as input errors", () => {
        const ten = (anchor: string) => Array(10).fill(`*${anchor}`).join(", ");
        const content = 'swagger: "2.0"\nx-a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\n' +
            `x-b: &b [${ten("a")}]\nx-c: &c [${ten("b")}]\nx-data: [${ten("c")}]\n`;
        expectError(content, "INVALID_SYNTAX");
    });
});
import fs from "node:fs";
import path from "node:path";
