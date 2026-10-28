import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { array, object, schemas, schemaRef, type Dialect, type JsonObject } from "@/tests/fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({ fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn() }));
const mapping = jest.mocked(fetchRepoMap);
const fetchBaseline = jest.mocked(fetchSpecFromGitea);
const prefix = "BAS-080-01-2507-2507-M";
const versionId = "VER-030-01-2507-2507-O-5";
let rules: AutoRule[];
const pairs: [Dialect, Dialect][] = [
    ["swagger2", "swagger2"], ["openapi3", "openapi3"], ["swagger2", "openapi3"], ["openapi3", "swagger2"],
];

function fixture(dialect: Dialect, inline = false): JsonObject {
    const input: JsonObject = { type: "object", properties: { name: { type: "string", enum: ["a", "b"] } } };
    const output: JsonObject = { type: "object", properties: { id: { type: "string" } } };
    const operation: JsonObject = {
        responses: {
            "200": { description: "OK", headers: { "X-Request-ID": dialect === "swagger2"
                ? { type: "string" } : { schema: { type: "string" } } } },
        },
    };
    const response = object(object(operation.responses)["200"]);
    const inputSchema = inline ? input : schemaRef(dialect, "Input");
    const outputSchema = inline ? output : schemaRef(dialect, "Output");
    const common = { info: { title: "Native", version: "v1" }, paths: { "/v1/resources": { post: operation } } };
    if (dialect === "swagger2") {
        operation.parameters = [{ name: "payload", in: "body", required: false, schema: inputSchema }];
        response.schema = outputSchema;
        return { ...common, swagger: "2.0", consumes: ["application/json"], produces: ["application/json"],
            definitions: { Input: input, Output: output } };
    }
    operation.requestBody = { content: { "application/json": { schema: inputSchema } } };
    response.content = { "application/json": { schema: outputSchema } };
    return { ...common, openapi: "3.0.3", components: { schemas: { Input: input, Output: output } } };
}

function operation(spec: JsonObject): JsonObject {
    return object(object(object(spec.paths)["/v1/resources"]).post);
}

function freeze(value: unknown, visited = new WeakSet<object>()): void {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    Object.values(value).forEach((child: unknown) => freeze(child, visited));
    Object.freeze(value);
}

async function compare(current: JsonObject, baseline: JsonObject, ids = rules.map((rule) => rule.id)) {
    freeze(current);
    freeze(baseline);
    const previous = JSON.stringify(baseline);
    mapping.mockResolvedValue({ reponame: "native", filename: "native" });
    fetchBaseline.mockResolvedValue(baseline);
    const content = yaml.dump(current, { noRefs: true });
    const result = await runLinter(content, rules.filter((rule) => ids.includes(rule.id)));
    expect(JSON.stringify(baseline)).toBe(previous);
    return { ...result, content };
}

beforeAll(async () => {
    const files = ["Compatibility.yaml", "API_version_management.yaml"]
        .map((file) => path.join(process.cwd(), "public/rulesets/default", file));
    const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
    rules = getImplementedRules(catalog, functionsMap).filter((rule) => rule.id.startsWith(prefix) || rule.id === versionId);
    expect(rules).toHaveLength(8);
});
beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe.each(pairs)("native baseline %s/%s", (currentDialect, baselineDialect) => {
    test("all eight rules accept equivalent immutable native documents and coalesce the baseline", async () => {
        const { diagnostics } = await compare(fixture(currentDialect), fixture(baselineDialect));
        expect(diagnostics).toEqual([]);
        expect(mapping).toHaveBeenCalledTimes(1);
        expect(fetchBaseline).toHaveBeenCalledTimes(1);
    });

    test("inline current schemas match referenced baseline schemas", async () => {
        expect((await compare(fixture(currentDialect, true), fixture(baselineDialect))).diagnostics).toEqual([]);
    });

    test("local Path Item references and metadata are not synthetic operations", async () => {
        const current = fixture(currentDialect);
        const baseline = fixture(baselineDialect);
        for (const spec of [current, baseline]) {
            const paths = object(spec.paths);
            spec["x-path-items"] = { item: paths["/v1/resources"] };
            paths["/v1/resources"] = { $ref: "#/x-path-items/item" };
        }
        object(baseline.paths)["x-metadata"] = { get: {} };
        expect((await compare(current, baseline)).diagnostics).toEqual([]);
    });

    test("optional request additions are still reported with the real string element binding", async () => {
        const current = fixture(currentDialect);
        object(object(schemas(current, currentDialect).Input).properties).optional = { type: "boolean" };
        const { diagnostics } = await compare(current, fixture(baselineDialect), [`${prefix}-2`]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('property "optional" was added');
    });

    test("recursive refs and the same schema reused at multiple property paths terminate without false changes", async () => {
        const current = fixture(currentDialect);
        const baseline = fixture(baselineDialect);
        for (const [spec, dialect] of [[current, currentDialect], [baseline, baselineDialect]] as const) {
            const properties = object(object(schemas(spec, dialect).Input).properties);
            properties.next = schemaRef(dialect, "Input");
            properties.left = schemaRef(dialect, "Output");
            properties.right = schemaRef(dialect, "Output");
        }
        expect((await compare(current, baseline)).diagnostics).toEqual([]);
    });

    test("allOf and implicit object schemas retain native fields", async () => {
        const current = fixture(currentDialect);
        const baseline = fixture(baselineDialect);
        for (const [spec, dialect] of [[current, currentDialect], [baseline, baselineDialect]] as const) {
            const definitions = schemas(spec, dialect);
            definitions.Input = { allOf: [{ properties: { name: { type: "string" } } }] };
        }
        object(object(array(object(schemas(current, currentDialect).Input).allOf)[0]).properties).added = { type: "string" };
        const { diagnostics } = await compare(current, baseline, [`${prefix}-2`]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain('property "added" was added');
    });

    test("enum disappearance remains out of scope", async () => {
        const current = fixture(currentDialect);
        delete object(object(object(schemas(current, currentDialect).Input).properties).name).enum;
        expect((await compare(current, fixture(baselineDialect), [`${prefix}-4`])).diagnostics).toEqual([]);
    });

    test("header casing and type changes do not become header-name changes", async () => {
        const current = fixture(currentDialect);
        const response = object(object(operation(current).responses)["200"]);
        response.headers = { "x-request-id": currentDialect === "swagger2"
            ? { type: "integer" } : { schema: { type: "integer" } } };
        expect((await compare(current, fixture(baselineDialect), [`${prefix}-6`])).diagnostics).toEqual([]);
    });

    test("native form fields and file types match without a synthetic Swagger conversion", async () => {
        const current = fixture(currentDialect);
        const baseline = fixture(baselineDialect);
        for (const [spec, dialect] of [[current, currentDialect], [baseline, baselineDialect]] as const) {
            const op = operation(spec);
            if (dialect === "swagger2") {
                spec.consumes = ["multipart/form-data"];
                op.parameters = [
                    { in: "formData", name: "name", type: "string", required: true },
                    { in: "formData", name: "file", type: "file" },
                ];
            } else {
                op.requestBody = { required: true, content: { "multipart/form-data": { schema: {
                    type: "object", required: ["name"],
                    properties: { name: { type: "string" }, file: { type: "string", format: "binary" } },
                } } } };
            }
        }
        expect((await compare(current, baseline)).diagnostics).toEqual([]);
    });
});

test.each(["mapping", "fetch", "invalid"] as const)("unavailable %s fails every selected baseline rule, not the document parser", async (failure) => {
    mapping.mockResolvedValue(failure === "mapping" ? null : { reponame: "native", filename: "native" });
    fetchBaseline.mockResolvedValue(failure === "invalid" ? { openapi: "3.1.0" } : null);
    const { diagnostics } = await runLinter(yaml.dump(fixture("swagger2")), rules);
    expect(diagnostics).toHaveLength(8);
    for (const diagnostic of diagnostics) {
        expect(diagnostic).toMatchObject({ from: 0, to: 0, lineNumber: 1 });
        expect(diagnostic.severity).toBe("error");
        expect(diagnostic.source).not.toBe("parser");
        expect(diagnostic.message).toMatch(/execution failed.*[Bb]aseline/);
    }
    expect(mapping).toHaveBeenCalledTimes(1);
    expect(fetchBaseline).toHaveBeenCalledTimes(failure === "mapping" ? 0 : 1);
});

test("baseline failures retry on the next validation and successful data never becomes a lifetime cache", async () => {
    const spec = fixture("swagger2");
    const content = yaml.dump(spec);
    mapping.mockResolvedValue({ reponame: "native", filename: "native" });
    fetchBaseline.mockResolvedValueOnce(null).mockResolvedValueOnce(spec).mockResolvedValueOnce(fixture("openapi3"));
    expect((await runLinter(content, rules)).diagnostics).toHaveLength(8);
    expect((await runLinter(content, rules)).diagnostics).toEqual([]);
    expect((await runLinter(content, rules)).diagnostics).toEqual([]);
    expect(fetchBaseline).toHaveBeenCalledTimes(3);
});

test("necessary broken baseline refs fail explicitly without highlighting an unrelated current schema", async () => {
    const baseline = fixture("openapi3");
    schemas(baseline, "openapi3").Input = { $ref: "#/missing" };
    const { diagnostics } = await compare(fixture("openapi3"), baseline, [`${prefix}-1`]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("execution failed");
    expect(diagnostics[0].message).toContain("#/missing");
    expect(diagnostics[0]).toMatchObject({ from: 0, to: 0, lineNumber: 1 });
});

test("baseline accessor failures cannot borrow coordinates from the current document either", async () => {
    const baseline = fixture("openapi3");
    object(schemas(baseline, "openapi3").Input).properties = null;
    const { diagnostics } = await compare(fixture("openapi3"), baseline, [`${prefix}-1`]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Cannot inspect baseline");
    expect(diagnostics[0]).toMatchObject({ from: 0, to: 0, lineNumber: 1 });
});

test.each(["", "\r\n# vendor comment\r\n", "# first comment\n# second comment\n"])("baseline failures remain on line one with prefix %j", async (leading) => {
    mapping.mockResolvedValue(null);
    const { diagnostics } = await runLinter(leading + yaml.dump(fixture("swagger2")), rules);
    expect(diagnostics).toHaveLength(8);
    for (const diagnostic of diagnostics) expect(diagnostic).toMatchObject({ from: 0, to: 0, lineNumber: 1 });
});

test("ordinary execution failures keep their existing document range", async () => {
    jest.spyOn(functionsMap, "checkCompatibility").mockImplementation(() => { throw new Error("Unrelated execution failure"); });
    const content = yaml.dump(fixture("swagger2"));
    const selected = rules.filter((rule) => rule.id === prefix);
    const { diagnostics } = await runLinter(content, selected);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ from: 0, to: content.length });
    expect(diagnostics[0].message).toContain("Unrelated execution failure");
});

test("reference errors in the current document retain their authored coordinates", async () => {
    const current = fixture("openapi3");
    schemas(current, "openapi3").Input = { $ref: "#/missing" };
    const { diagnostics, content } = await compare(current, fixture("openapi3"), [`${prefix}-1`]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].from).toBeGreaterThan(0);
    expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toContain("#/missing");
    expect(diagnostics[0].lineNumber).toBeGreaterThan(1);
});

test("allOf form fields and required declarations are compared against native Swagger formData", async () => {
    const baseline = fixture("swagger2");
    baseline.consumes = ["multipart/form-data"];
    operation(baseline).parameters = [{ in: "formData", name: "name", type: "string", required: true }];
    const current = fixture("openapi3");
    operation(current).requestBody = { required: true, content: { "multipart/form-data": { schema: {
        allOf: [{ properties: { name: { type: "string" } } }, { required: ["name"] }],
    } } } };
    expect((await compare(current, baseline)).diagnostics).toEqual([]);
});

test("adding a form alternative does not erase the existing JSON body container", async () => {
    const current = fixture("openapi3");
    const content = object(object(operation(current).requestBody).content);
    content["multipart/form-data"] = { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } };
    expect((await compare(current, fixture("swagger2"), [versionId])).diagnostics).toEqual([]);
});

test("effective operation parameters override inherited required declarations", async () => {
    const current = fixture("swagger2");
    const baseline = fixture("openapi3");
    for (const spec of [current, baseline]) {
        object(object(spec.paths)["/v1/resources"]).parameters = [
            { name: "filter", in: "query", required: true, type: "string", schema: { type: "string" } },
        ];
        const op = operation(spec);
        const inheritedOverride = { name: "filter", in: "query", required: false, type: "string", schema: { type: "string" } };
        op.parameters = [...(Array.isArray(op.parameters) ? op.parameters : []), inheritedOverride];
    }
    expect((await compare(current, baseline, [versionId])).diagnostics).toEqual([]);
});

test("unspecified Swagger produces is not an implicit JSON type or a removed media declaration", async () => {
    const current = fixture("swagger2");
    delete current.produces;
    expect((await compare(current, fixture("openapi3"), [versionId])).diagnostics).toEqual([]);
});

test("operation-level produces overrides the root declaration", async () => {
    const current = fixture("swagger2");
    operation(current).produces = ["application/xml"];
    const { diagnostics, content } = await compare(current, fixture("openapi3"), [versionId]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Response media type 'application/json'");
    expect(content.slice(diagnostics[0].from, diagnostics[0].to)).toBe("v1");
});

test("the configured API deletion scope and the versioning seven-method scope stay distinct", async () => {
    const current = fixture("openapi3");
    const baseline = fixture("openapi3");
    object(object(baseline.paths)["/v1/resources"]).head = { responses: { "204": { description: "OK" } } };
    object(object(baseline.paths)["/v1/resources"]).trace = { responses: { "204": { description: "OK" } } };
    const { diagnostics } = await compare(current, baseline, [prefix, versionId]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("HEAD /v1/resources");
    expect(diagnostics[0].message).not.toContain("TRACE");
});

test("only success status removals affect versioning, while compatibility retains all status codes", async () => {
    const baseline = fixture("swagger2");
    object(operation(baseline).responses)["400"] = { description: "Bad request" };
    const { diagnostics } = await compare(fixture("openapi3"), baseline, [`${prefix}-5`, versionId]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Response code 400 was deleted");
});
