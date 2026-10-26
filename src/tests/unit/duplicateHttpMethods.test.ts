import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getImplementedRules, parseRuleFile, type AutoRule } from "@/lib/linter/ruleCatalog";
import { jsonPointer } from "@/lib/openapi/references";
import { sourceLineNumber, sourceMap } from "@/lib/openapi/sourceMap";

function ruleFrom(file: string, name: string): AutoRule {
    const content = fs.readFileSync(path.join("public/rulesets/default", file), "utf8");
    const rule = getImplementedRules(parseRuleFile(content, file), functionsMap).find((entry) => entry.call.function === name);
    if (!rule) throw new Error(`Missing rule ${name}.`);
    return rule;
}

const structure = ruleFrom("OAS_Compliance.yaml", "checkOASSpec");
const versionRule = ruleFrom("OAS_Compliance.yaml", "checkOASVersion");
const successRule = ruleFrom("Request_Verb_And_Response_Status_Code.yaml", "checkSuccessResponse");
const methods = ["get", "post", "put", "delete", "patch", "head", "options", "trace"];
type Format = "block" | "flow" | "json";

beforeEach(() => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Duplicate-method checks must not use the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe.each(["swagger", "openapi"])("%s duplicate HTTP methods", (versionKey) => {
    const value = versionKey === "swagger" ? "2.0" : "3.0.3";
    const prefix = `${versionKey}: "${value}"\ninfo: {}\n`;
    function duplicate(method: string, format: Format): string {
        if (format === "json") {
            return `{"${versionKey}":"${value}","info":{},"paths":{"/v1/resources":{"${method}":{},"${method}":{}}}}`;
        }
        if (format === "flow") return `${prefix}paths: {"/v1/resources": {${method}: {}, ${method}: {}}}\n`;
        return `${prefix}paths:\n  "/v1/resources":\n    ${method}: {}\n    ${method}: {}\n`;
    }

    describe.each<Format>(["block", "flow", "json"])("%s source", (format) => {
        test.each(methods)("reports duplicate %s once on the original path key", async (method) => {
            const content = duplicate(method, format);
            const before = JSON.stringify(yaml.load(content, { json: true }));
            const { diagnostics } = await runLinter(content, [versionRule, structure]);
            expect(diagnostics).toHaveLength(1);
            const [finding] = diagnostics;
            expect(finding.source).toContain("BAS-110-01-2507-2507-M-1");
            expect(finding.severity).toBe("error");
            expect(finding.message).toContain(`${method.toUpperCase()} (2 declarations; lines `);
            expect(finding.message).toContain("only the last value is used for validation");
            expect(content.slice(finding.from, finding.to)).toBe('"/v1/resources"');
            expect(finding.from).toBe(content.indexOf('"/v1/resources"'));
            expect(finding.lineNumber).toBe(sourceLineNumber(content, finding.from));
            expect(JSON.stringify(yaml.load(content, { json: true }))).toBe(before);
        });
    });

    test("aggregates all repeated methods once per affected path, including null/primitive declarations", async () => {
        const content = `${prefix}paths:
  /v1/first:
    get: {}
    post: {}
    get: null
    put: {}
    get: true
    post: {}
  /v1/second:
    delete: {}
    delete: {}
  /v1/valid:
    get: {}
    post: {}
`;
        const { diagnostics } = await runLinter(content, [structure]);
        expect(diagnostics).toHaveLength(2);
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("/v1/first");
        expect(diagnostics[0].message).toContain("GET (3 declarations; lines 5, 7, 9)");
        expect(diagnostics[0].message).toContain("POST (2 declarations; lines 6, 10)");
        expect(diagnostics[0].message).not.toContain("PUT (");
        expect(content.slice(diagnostics[1].from, diagnostics[1].to)).toBe("/v1/second");
        expect(diagnostics[1].message).toContain("DELETE (2 declarations; lines 12, 13)");
    });

    test("does not treat metadata, nested fields or the same method on different paths as duplicates", async () => {
        const content = `${prefix}paths:
  x-metadata: {get: {}, get: {}}
  /v1/first:
    parameters: [{name: get, in: query, schema: {type: string}}]
    get:
      responses:
        "200":
          content:
            application/json:
              schema: {properties: {get: {}, get: {}}}
    x-custom: {get: {}, get: {}}
  /v1/second:
    get: {}
    post: {}
`;
        expect((await runLinter(content, [structure])).diagnostics).toEqual([]);
    });

    test("follows local Path Item reference chains and reports each referring path", async () => {
        const content = `${prefix}paths:
  /v1/first: {$ref: "#/x-items/A"}
  /v1/second: {$ref: "#/x-items/B"}
x-items:
  A: {$ref: "#/x-items/B"}
  B: {get: {}, get: {}, post: {}}
`;
        const { diagnostics } = await runLinter(content, [structure]);
        expect(diagnostics).toHaveLength(2);
        for (const [index, key] of ["/v1/first", "/v1/second"].entries()) {
            expect(content.slice(diagnostics[index].from, diagnostics[index].to)).toBe(key);
            expect(diagnostics[index].message).toContain("GET (2 declarations; lines 8, 8)");
        }
    });

    test("inspects aliases/merges without counting legitimate overrides across mappings as repeated keys", async () => {
        const content = `${prefix}x-base: &base {get: {}, get: {}}
x-clean: &clean {get: {}, post: {}}
paths:
  /v1/alias: *base
  /v1/merged:
    <<: [*base, *clean]
    post: {}
  /v1/valid:
    <<: *clean
    get: {}
`;
        const { diagnostics } = await runLinter(content, [structure]);
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics.map((finding) => content.slice(finding.from, finding.to)))
            .toEqual(["/v1/alias", "/v1/merged"]);
        expect(diagnostics.every((finding) => finding.message.includes("GET (2 declarations; lines 3, 3)"))).toBe(true);
        expect(diagnostics.every((finding) => !finding.message.includes("POST ("))).toBe(true);
    });

    test.each(["\n", "\r\n", "\r"])("preserves quoted Unicode path ranges and lines with %j", async (newline) => {
        const content = `${prefix}paths:\n  "/caf\\u00e9/~":\n    get: {}\n    get: {}\n`.replace(/\n/g, newline);
        const [finding] = (await runLinter(content, [structure])).diagnostics;
        expect(content.slice(finding.from, finding.to)).toBe('"/caf\\u00e9/~"');
        expect(finding.lineNumber).toBe(4);
        expect(finding.message).toContain('path "/café/~"');
        expect(finding.message).toContain("GET (2 declarations; lines 5, 6)");
        expect(finding).toMatchObject({ pointer: jsonPointer(["paths", "/café/~"]) });
    });

    test.each([false, undefined])("does not expand custom configuration when checkDuplicateMethods is %j", async (enabled) => {
        const custom = {
            ...structure, call: {
                ...structure.call,
                functionParams: { ...structure.call.functionParams, checkDuplicateMethods: enabled },
            },
        };
        expect((await runLinter(duplicate("get", "block"), [custom])).diagnostics).toEqual([]);
    });

    test("does not block other selected rules or change last-value-wins semantics", async () => {
        const content = `${prefix}paths:
  /v1/resources:
    get: {operationId: first, responses: {"200": {description: OK}}}
    get: {operationId: last, responses: {"404": {description: Missing}}}
`;
        const standalone = (await runLinter(content, [successRule])).diagnostics;
        const combined = (await runLinter(content, [versionRule, structure, successRule])).diagnostics;
        expect(standalone).toHaveLength(1);
        expect(combined).toHaveLength(2);
        expect(combined.filter((finding) => finding.source === standalone[0].source)).toEqual(standalone);
        expect(combined.some((finding) => finding.source === "parser")).toBe(false);
        expect((await runLinter(content, [versionRule])).diagnostics).toEqual([]);
        expect(yaml.load(content, { json: true })).toMatchObject({
            paths: { "/v1/resources": { get: { operationId: "last", responses: { "404": { description: "Missing" } } } } },
        });
    });

    test.each(["external.yaml#/A", "#/missing", "#bad", "#/x-loop"])("surfaces a necessary unavailable Path Item ref %s only under this rule", async (ref) => {
        const content = `${prefix}paths: {"/v1/resources": {$ref: "${ref}"}}\nx-loop: {$ref: "#/x-loop"}\n`;
        const [finding, ...others] = (await runLinter(content, [structure, versionRule])).diagnostics;
        expect(others).toEqual([]);
        expect(finding.source).toContain(structure.id);
        expect(finding.message).toContain("execution failed");
        expect(content.slice(finding.from, finding.to)).toBe(JSON.stringify(ref));
        expect(finding.source).not.toBe("parser");
    });

    test("does not resolve overwritten reference values", async () => {
        const content = `${prefix}paths:
  /v1/resources: {$ref: "#/missing", $ref: "#/x-item"}
x-item: {get: {}, get: {}}
`;
        const { diagnostics } = await runLinter(content, [structure]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("GET (2 declarations; lines 5, 5)");
        expect(diagnostics[0].message).not.toContain("execution failed");
    });

    test("keeps malformed reference failures under the selected rule, not the parser", async () => {
        const content = `${prefix}paths: {"/v1/resources": {$ref: 42}}\n`;
        const { diagnostics } = await runLinter(content, [structure]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].source).toContain(structure.id);
        expect(diagnostics[0].message).toContain("Expected a Path Item reference string");
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("42");
    });
});

test("rejects malformed configuration instead of silently disabling detection", async () => {
    const custom = {
        ...structure, call: { ...structure.call, functionParams: { ...structure.call.functionParams, checkDuplicateMethods: "true" } },
    };
    const { diagnostics } = await runLinter("openapi: 3.0.3\ninfo: {}\npaths: {}", [custom]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("functionParams.checkDuplicateMethods must be a boolean");
});

test("adding the opt-in AST reader does not change existing ambiguous coordinate fallback", () => {
    const content = "paths:\n  /first:\n    get: {}\n    get: {}\n";
    const map = sourceMap(content);
    const before = map.locate("#/paths/~1first/get");
    expect(map.duplicateMethods()).toHaveLength(1);
    expect(map.locate("#/paths/~1first/get")).toEqual(before);
    expect(before).toMatchObject({ lineNumber: 2, fallback: "ambiguous" });
});
