import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getSource } from "@/functions/common";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import {
    array, buildScenario, object, schemas, type Dialect, type JsonObject,
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
