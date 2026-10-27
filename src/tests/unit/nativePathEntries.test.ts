import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { collectDocumentOperations } from "@/lib/openapi/operations";
import { collectDocumentPathEntries } from "@/lib/openapi/paths";
import { jsonPointer, resolveReference } from "@/lib/openapi/references";
import { sourceLineNumber, sourceMap } from "@/lib/openapi/sourceMap";
import { collectHeaderLocations } from "@/utils/scan";
import { rulePathKeys } from "@/utils/nativeRule";
import type { Dialect, JsonObject } from "../fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(() => { throw new Error("Unexpected baseline lookup."); }),
    fetchSpecFromGitea: jest.fn(() => { throw new Error("Unexpected baseline fetch."); }),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Path traversal must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Path traversal must not convert."); }),
}), { virtual: true });

const rules = new Map<string, AutoRule>();
beforeAll(async () => {
    const files = ["OAS_Compliance", "Request_URI_Format", "Request_Verb_And_Response_Status_Code", "Security"]
        .map((name) => `${process.cwd()}/public/rulesets/default/${name}.yaml`);
    const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) {
        if (!rules.has(rule.call.function)) rules.set(rule.call.function, rule);
    }
});
beforeEach(() => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Path traversal must stay offline."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function ruleFor(fn: string): AutoRule {
    const rule = rules.get(fn);
    if (!rule) throw new Error(`Missing native path rule ${fn}`);
    return rule;
}
function document(dialect: Dialect, paths: JsonObject): JsonObject {
    return {
        ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native numbered paths", version: "v1" }, paths,
    };
}
const formats = ["yaml", "json", "flow"] as const;
function text(spec: JsonObject, format: typeof formats[number]): string {
    return (format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) }))
        .replace(/\n/g, "\r\n");
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s raw path entries", (dialect) => {
    test("retains all 70 operations under 30 distinct numbered keys and exact method/path filters", () => {
        const paths: JsonObject = {};
        for (let index = 1; index <= 30; index++) {
            paths[`${String(index).padStart(2, "0")} /`] = {
                get: {}, put: {}, ...(index <= 10 ? { post: {} } : {}),
            };
        }
        paths["x-hidden"] = { get: {}, put: {}, post: {} };
        const spec = document(dialect, paths);
        const before = JSON.stringify(spec);
        const operations = collectDocumentOperations(spec);
        expect(operations).toHaveLength(70);
        expect(new Set(operations.map((operation) => operation.path)).size).toBe(30);
        expect(collectDocumentPathEntries(spec)).toHaveLength(30);
        expect(rulePathKeys(spec)).toEqual(Object.keys(paths).filter((key) => key !== "x-hidden"));
        expect(collectDocumentOperations(spec, ["GET"])).toHaveLength(30);
        expect(collectDocumentOperations(spec, [])).toEqual([]);
        expect(collectDocumentOperations(spec, undefined, (path) => path === "01 /")).toHaveLength(3);
        expect(collectDocumentOperations(spec, undefined, (path) => path === "/")).toEqual([]);
        for (const operation of operations) {
            expect(resolveReference(operation.pointer, spec).value).toBe(operation.operation);
            expect(operation.pathItemPointer).toBe(jsonPointer(["paths", operation.path]));
        }
        expect(JSON.stringify(spec)).toBe(before);
        expect(Object.hasOwn(paths, "/")).toBe(false);
    });

    test.each(formats)("%s reports invalid keys and runs independent native operation rules at original coordinates", async (format) => {
        const spec = document(dialect, {
            "01 /": { get: { responses: { "400": { description: "Bad request" } } } },
            "02 /": {
                get: { responses: { "400": { description: "Bad request" } } },
                post: {}, brew: {},
            },
            "x-hidden": { get: {}, brew: {} },
        });
        const content = text(spec, format);
        const expected = [
            { fn: "checkOASSpec", count: 2 },
            { fn: "checkURIFormat", count: 2 },
            { fn: "checkSuccessResponse", count: 2 },
            { fn: "checkCRUD", count: 1 },
            { fn: "checkAllowedMethods", count: 1 },
        ];
        const { diagnostics } = await runLinter(content, expected.map(({ fn }) => ruleFor(fn)));
        expect(diagnostics).toHaveLength(8);
        for (const { fn, count } of expected) {
            const own = diagnostics.filter((diagnostic) => diagnostic.source?.includes(ruleFor(fn).id));
            expect(own).toHaveLength(count);
            if (fn === "checkOASSpec" || fn === "checkURIFormat") {
                expect(own.map((diagnostic) => content.slice(diagnostic.from, diagnostic.to)))
                    .toEqual(expect.arrayContaining([expect.stringContaining("01 /"), expect.stringContaining("02 /")]));
            }
            if (fn === "checkOASSpec") {
                expect(own.every((diagnostic) => diagnostic.message.includes('must start with "/"'))).toBe(true);
            }
            if (fn === "checkSuccessResponse") {
                expect(own.map((diagnostic) => diagnostic.from))
                    .toEqual([content.indexOf(format === "json" ? '"get"' : "get"),
                        content.indexOf(format === "json" ? '"get"' : "get", content.indexOf("02 /"))]);
            }
        }
        for (const diagnostic of diagnostics) {
            expect(diagnostic.message).not.toContain("execution failed");
            expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
            expect(diagnostic.from).toBeGreaterThanOrEqual(0);
            expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        }
    });

    test.each(formats)("%s checks empty keys without treating x- extensions as paths, and permits custom opt-out", async (format) => {
        const content = text(document(dialect, { "": { get: {} }, "x-hidden": { get: {} }, "/": { get: {} } }), format);
        const rule = ruleFor("checkOASSpec");
        const { diagnostics } = await runLinter(content, [rule]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('Path key "" must start with "/"');
        expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe(format === "json" ? '""' : "''");
        const disabled = { ...rule, call: { ...rule.call,
            functionParams: { ...rule.call.functionParams, checkPathKeys: false } } };
        expect((await runLinter(content, [disabled])).diagnostics).toEqual([]);
    });

    test("follows native references/aliases and audits duplicate methods without normalizing numbered keys", async () => {
        const content = [
            dialect === "swagger2" ? 'swagger: "2.0"' : "openapi: 3.0.3",
            "info: {title: Native paths, version: v1}",
            "x-items:",
            "  Shared: &item",
            "    parameters:",
            `      - {name: bad_header, in: header, ${dialect === "swagger2" ? "type: string" : "schema: {type: string}"}}`,
            '    get: {responses: {"400": {description: First}}}',
            '    get: {responses: {"400": {description: Last, headers: {bad_response: {type: string}}}}}',
            "paths:",
            '  "01 /": {$ref: "#/x-items/Shared"}',
            '  "02 /": *item',
            '  x-hidden: {get: {}, get: {}}',
        ].join("\r\n");
        const spec: unknown = yaml.load(content, { json: true });
        const before = JSON.stringify(spec);
        const operations = collectDocumentOperations(spec);
        expect(operations.map(({ path }) => path)).toEqual(["01 /", "02 /"]);
        expect(operations[0].pointer).toBe("#/x-items/Shared/get");
        expect(operations[1].pointer).toBe("#/paths/02%20~1/get");
        const headers = collectHeaderLocations(spec);
        expect(headers.map(({ headerName }) => headerName)).toEqual([
            "bad_header", "bad_header", "bad_response", "bad_response",
        ]);
        for (const header of headers) {
            const location = sourceMap(content).locate(header.sourcePointer, header.direction === "request" ? "value" : "key");
            expect(content.slice(location.from, location.to)).toBe(header.headerName);
        }
        expect(sourceMap(content).duplicateMethods().map(({ path, methods }) => ({ path, methods }))).toEqual([
            { path: "01 /", methods: [{ method: "get", lines: [7, 8] }] },
            { path: "02 /", methods: [{ method: "get", lines: [7, 8] }] },
        ]);
        const { diagnostics } = await runLinter(content, [ruleFor("checkOASSpec"), ruleFor("checkSuccessResponse")]);
        expect(diagnostics).toHaveLength(6);
        expect(diagnostics.filter(({ message }) => message.includes("Duplicate HTTP methods"))).toHaveLength(2);
        expect(diagnostics.filter(({ source }) => source?.includes(ruleFor("checkSuccessResponse").id))
            .every(({ from }) => from === content.lastIndexOf('get: {responses: {"400": {description: Last'))).toBe(true);
        expect(diagnostics.some(({ message }) => message.includes("execution failed"))).toBe(false);
        expect(JSON.stringify(spec)).toBe(before);
    });
});
