import fs from "node:fs/promises";
import * as yaml from "js-yaml";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { isRecord } from "@/lib/openapi/references";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Native query checks must not convert."); }),
    convertObj: jest.fn(() => { throw new Error("Native query checks must not convert."); }),
}), { virtual: true });

type Doc = Record<string, unknown>;
type Dialect = "swagger2" | "openapi3";
type Format = "yaml" | "json" | "flow";
const formats: Format[] = ["yaml", "json", "flow"];
const limit = "FIL-020-01-2507-2507-M-1";
const sorting = "FIL-030-01-2507-2507-M";
const filter = "FIL-010-01-2507-2507-O";
const ids = [limit, sorting, filter];
const rules = new Map<string, AutoRule>();

beforeAll(async () => {
    const paths = ["Pagination_Parameter_Specification", "Sorting_Parameter_Specification", "Filtering_By_Attribute_Conditions"]
        .map((name) => `${process.cwd()}/public/rulesets/default/${name}.yaml`);
    const catalog = await loadRuleCatalog(paths, (file) => fs.readFile(file, "utf8"));
    for (const rule of getImplementedRules(catalog, functionsMap)) if (ids.includes(rule.id)) rules.set(rule.id, rule);
    expect(rules.size).toBe(3);
});
beforeEach(() => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native query checks must not access the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});
function object(value: unknown): Doc {
    if (!isRecord(value)) throw new Error("Expected fixture object");
    return value;
}
function document(dialect: Dialect, operation: Doc, pathItem: Doc = {}, extra: Doc = {}): Doc {
    return { ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Native query", version: "v1" }, paths: { "/v1/users": { ...pathItem, get: operation } }, ...extra };
}
function parameter(dialect: Dialect, name: string, schema: Doc = {}, location = "query"): Doc {
    return { name, in: location, ...(dialect === "swagger2" ? { type: "string", ...schema } : { schema: { type: "string", ...schema } }) };
}
function response(dialect: Dialect, schema: Doc): Doc {
    return { description: "OK", ...(dialect === "swagger2" ? { schema } : { content: { "application/json": { schema } } }) };
}
function sortParams(dialect: Dialect, schema: Doc = { enum: ["asc", "desc"], default: "asc" }): Doc[] {
    return [parameter(dialect, "sort_key"), parameter(dialect, "sort_dir", schema)];
}
async function check(spec: Doc, id: string, params: Doc = {}, format: Format = "yaml") {
    const base = rules.get(id);
    if (!base) throw new Error(`Missing rule ${id}`);
    const rule = { ...base, call: { ...base.call, functionParams: { ...base.call.functionParams, ...params } } };
    const content = format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) });
    const { diagnostics } = await runLinter(content, [rule]);
    for (const diagnostic of diagnostics) {
        expect(diagnostic.source).toContain(id);
        expect(diagnostic.from).toBeGreaterThanOrEqual(0);
        expect(diagnostic.to).toBeLessThanOrEqual(content.length);
        expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
    }
    return { diagnostics, content };
}

describe.each(["swagger2", "openapi3"] satisfies Dialect[])("%s native query contracts", (dialect) => {
    test.each(formats)("%s checks inherited native limit default and string-equivalent configuration", async (format) => {
        for (const value of [1000, "1000", 25, null, undefined]) {
            const field = parameter(dialect, "limit", value === undefined ? {} : { default: value });
            const spec = document(dialect, {}, { parameters: [field] });
            expect((await check(spec, limit, {}, format)).diagnostics).toHaveLength(String(value) === "1000" ? 0 : 1);
        }
        expect((await check(document(dialect, {}), limit, {}, format)).diagnostics).toEqual([]);
        expect((await check(document(dialect, { parameters: [parameter(dialect, "limit")] }), limit,
            { defaultValue: null }, format)).diagnostics).toEqual([]);
    });
    test.each(formats)("%s checks native sorting enums/defaults, optional enums and aggregation", async (format) => {
        expect((await check(document(dialect, { parameters: sortParams(dialect) }), sorting, {}, format)).diagnostics).toEqual([]);
        const invalid = document(dialect, { parameters: sortParams(dialect, { enum: ["asc", "sideways"], default: "sideways" }) });
        const { diagnostics } = await check(invalid, sorting, {}, format);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("enum contains invalid value");
        expect(diagnostics[0].message).toContain("must have default 'asc'");
        expect((await check(invalid, sorting, { defaultDir: null, checkEnums: false }, format)).diagnostics).toEqual([]);
        expect((await check(document(dialect, { parameters: sortParams(dialect, { default: "ASC" }) }),
            sorting, {}, format)).diagnostics).toEqual([]);
        expect((await check(document(dialect, { parameters: [parameter(dialect, "order_by")] }),
            sorting, {}, format)).diagnostics).toEqual([]);
    });
    test.each(formats)("%s filters effective path parameters against native response 200", async (format) => {
        for (const valid of [true, false]) {
            const schema = { type: "object", properties: { items: { type: "array", items: {
                type: "object", properties: { [valid ? "USER_ID" : "other_id"]: { type: "string" } },
            } } } };
            const spec = document(dialect, { responses: { "200": response(dialect, schema) } },
                { parameters: [parameter(dialect, "user_id", {}, "path")] });
            expect((await check(spec, filter, {}, format)).diagnostics).toHaveLength(valid ? 0 : 1);
        }
    });
    test("operation override suppresses inherited defaults but not genuine same-level limit declarations", async () => {
        const good = parameter(dialect, "limit", { default: 1000 });
        const bad = parameter(dialect, "limit", { default: 25 });
        expect((await check(document(dialect, { parameters: [good] }, { parameters: [bad] }), limit)).diagnostics).toEqual([]);
        expect((await check(document(dialect, { parameters: [bad] }, { parameters: [good] }), limit)).diagnostics).toHaveLength(1);
        expect((await check(document(dialect, { parameters: [bad, good] }), limit)).diagnostics).toHaveLength(1);
        expect((await check(document(dialect, {}, { parameters: [bad, good] }), limit)).diagnostics).toHaveLength(1);
    });
    test("sorting retains inherited slots after override and does not enforce order when disabled", async () => {
        const [key, dir] = sortParams(dialect);
        expect((await check(document(dialect, { parameters: [dir, key] }, { parameters: [key, dir] }), sorting)).diagnostics).toEqual([]);
        const reversed = document(dialect, { parameters: [key, dir] }, { parameters: [dir, key] });
        expect((await check(reversed, sorting)).diagnostics).toHaveLength(1);
        expect((await check(reversed, sorting, { enforceOrder: false })).diagnostics).toEqual([]);
    });
    test("sorting reports either missing partner, and preserves activation and extra-sort policies", async () => {
        for (const fields of [[parameter(dialect, "sort_key")], [parameter(dialect, "sort_dir", { default: "asc" })]]) {
            const spec = document(dialect, { parameters: fields });
            expect((await check(spec, sorting)).diagnostics).toHaveLength(1);
            expect((await check(spec, sorting, { requireTogether: false })).diagnostics).toEqual([]);
        }
        const extra = document(dialect, { parameters: [...sortParams(dialect), parameter(dialect, "ordering")] });
        expect((await check(extra, sorting)).diagnostics).toHaveLength(1);
        expect((await check(extra, sorting, { disallowOtherSortParams: false })).diagnostics).toEqual([]);
    });
    test("defaultDirNotAllowed takes precedence and forbids any explicit native default", async () => {
        for (const value of ["asc", "desc", null, false, 0]) {
            const spec = document(dialect, { parameters: sortParams(dialect, { enum: ["asc", "desc"], default: value }) });
            const { diagnostics } = await check(spec, sorting, { defaultDirNotAllowed: true });
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("must not declare a default");
            expect(diagnostics[0].message).not.toContain("must have default");
        }
        const absent = document(dialect, { parameters: sortParams(dialect, { enum: ["asc", "desc"] }) });
        expect((await check(absent, sorting, { defaultDirNotAllowed: true })).diagnostics).toEqual([]);
        expect((await check(absent, sorting)).diagnostics).toHaveLength(1);
    });
    test("filter remains path-only, response-200-only and schema-optional", async () => {
        const path = parameter(dialect, "user_id", {}, "path");
        const missing = response(dialect, { type: "object" });
        for (const output of [{ "201": missing }, { "200": { description: "No body" } }]) {
            expect((await check(document(dialect, { parameters: [path], responses: output }), filter)).diagnostics).toEqual([]);
        }
        expect((await check(document(dialect, {
            parameters: [parameter(dialect, "user_id")], responses: { "200": missing },
        }), filter)).diagnostics).toEqual([]);
    });
    test("Path Item and parameter references are checked without metadata pseudo-operations", async () => {
        const shared = parameter(dialect, "limit", { default: 25 });
        const parameterRef = { $ref: `#/${dialect === "swagger2" ? "parameters" : "components/parameters"}/Shared` };
        const extra = dialect === "swagger2" ? { parameters: { Shared: shared } } : { components: { parameters: { Shared: shared } } };
        const spec = document(dialect, { parameters: [parameterRef] }, {}, extra);
        expect((await check(spec, limit)).diagnostics).toHaveLength(1);
        const item = object(object(spec.paths)["/v1/users"]);
        spec["x-path-items"] = { Shared: item };
        object(spec.paths)["/v1/users"] = { $ref: "#/x-path-items/Shared" };
        expect((await check(spec, limit)).diagnostics).toHaveLength(1);
        const inherited = document(dialect, {}, { parameters: [parameter(dialect, "sort_dir", { default: "asc" })] });
        expect((await check(inherited, sorting, { methods: [] })).diagnostics).toHaveLength(1);
        expect((await check(inherited, sorting, { methods: [] })).diagnostics[0].message).toContain("GET");
    });
    test.each([sorting, filter])("%s validates reusable native declarations behind Path Item refs", async (id) => {
        for (const valid of [true, false]) {
            const namespace = dialect === "swagger2" ? "" : "components/";
            const shared = id === sorting
                ? parameter(dialect, "sort_dir", { enum: [valid ? "asc" : "sideways"], default: valid ? "asc" : "sideways" })
                : parameter(dialect, "user_id", {}, "path");
            const parameters = { Shared: shared };
            const schemas = { Shared: { type: "object", properties: {
                [valid ? "USER_ID" : "other_id"]: { type: "string" },
            } } };
            const schemaNamespace = dialect === "swagger2" ? "definitions" : "components/schemas";
            const responses = { Shared: response(dialect, { $ref: `#/${schemaNamespace}/Shared` }) };
            const extra = dialect === "swagger2" ? { parameters, responses, definitions: schemas }
                : { components: { parameters, responses, schemas } };
            const fields: Doc[] = [{ $ref: `#/${namespace}parameters/Shared` }];
            if (id === sorting) fields.unshift(parameter(dialect, "sort_key"));
            const operation = id === filter ? { responses: { "200": { $ref: `#/${namespace}responses/Shared` } } } : {};
            const spec = document(dialect, operation, { parameters: fields }, extra);
            spec["x-path-items"] = { Shared: object(object(spec.paths)["/v1/users"]) };
            object(spec.paths)["/v1/users"] = { $ref: "#/x-path-items/Shared" };
            const { diagnostics } = await check(spec, id);
            expect(diagnostics).toHaveLength(valid ? 0 : 1);
            if (!valid) expect(diagnostics[0].message).not.toContain("execution failed");
        }
    });
    test("unselected parameter schemas and disabled schema checks are not resolved", async () => {
        const unused = parameter(dialect, "search", dialect === "swagger2"
            ? { schema: { $ref: "#/missing" } } : { $ref: "#/missing" });
        const spec = document(dialect, { parameters: [unused, parameter(dialect, "limit", { default: 1000 })] });
        expect((await check(spec, limit)).diagnostics).toEqual([]);
        const fields = [parameter(dialect, "sort_key"), parameter(dialect, "sort_dir",
            dialect === "swagger2" ? { schema: { $ref: "#/missing" } } : { $ref: "#/missing" })];
        expect((await check(document(dialect, { parameters: fields }), sorting,
            { checkEnums: false, defaultDir: null })).diagnostics).toEqual([]);
    });
    test("filter preserves short-circuit recursion, arrays, maps and composition semantics", async () => {
        const namespace = dialect === "swagger2" ? "definitions" : "components/schemas";
        const schema = { type: "object", properties: { user_id: { type: "string" }, ignored: { $ref: "#/missing" } } };
        const parameters = [parameter(dialect, "user_id", {}, "path")];
        expect((await check(document(dialect, { parameters, responses: { "200": response(dialect, schema) } }),
            filter)).diagnostics).toEqual([]);
        const schemas: Doc = { Recursive: { type: "object", properties: { child: { $ref: `#/${namespace}/Recursive` } },
            additionalProperties: { allOf: [{ type: "object", properties: { user_id: { type: "string" } } }] } } };
        const extra = dialect === "swagger2" ? { definitions: schemas } : { components: { schemas } };
        const output = response(dialect, { $ref: `#/${namespace}/Recursive` });
        expect((await check(document(dialect, { parameters, responses: { "200": output } }, {}, extra),
            filter)).diagnostics).toEqual([]);
    });
});

test.each([limit, sorting])("%s resolves native v3 parameter schema and content references", async (id) => {
    const name = id === limit ? "limit" : "sort_dir";
    const schema = id === limit ? { type: "integer", default: 1000 }
        : { type: "string", enum: ["asc", "desc"], default: "asc" };
    for (const content of [false, true]) {
        const declaration = { $ref: "#/components/schemas/Target~1value~0node" };
        const field = { name, in: "query", ...(content ? { content: { "application/json": { schema: declaration } } }
            : { schema: declaration }) };
        const parameters = id === sorting ? [parameter("openapi3", "sort_key"), field] : [field];
        const spec = document("openapi3", { parameters }, {}, { components: { schemas: { "Target/value~node": schema } } });
        expect((await check(spec, id)).diagnostics).toEqual([]);
    }
});
test("default reads use the native dialect location, not cross-version fallback", async () => {
    const v2 = document("swagger2", { parameters: [{
        name: "limit", in: "query", type: "integer", default: 1000, schema: { default: 25 },
    }] });
    expect((await check(v2, limit)).diagnostics).toEqual([]);
    const v3 = document("openapi3", { parameters: [{
        name: "limit", in: "query", default: 1000, schema: { type: "integer" },
    }] });
    expect((await check(v3, limit)).diagnostics).toHaveLength(1);
});
test("sorting preserves legacy config aliases", async () => {
    const spec = document("openapi3", { parameters: [
        parameter("openapi3", "order_dir", { enum: ["UP", "DOWN"], default: "UP" }),
        parameter("openapi3", "order_key"),
    ] });
    expect((await check(spec, sorting, {
        keywords: null, allowedKeywords: ["order_key", "order_dir"],
        allowedDirValues: null, allowedValues: ["up", "down"], defaultDir: null, defaultDirection: "up",
        enforceOrder: undefined, checkSequence: false, disallowOtherSortParams: undefined, disallowOtherParams: true,
    })).diagnostics).toEqual([]);
});
test("filter preserves JSON/problem+json preference and skips a selected media without a schema", async () => {
    const content: Doc = {
        "text/plain": { schema: { type: "object" } },
        "application/problem+json": { schema: { type: "object", properties: { user_id: { type: "string" } } } },
    };
    const spec = document("openapi3", { parameters: [parameter("openapi3", "user_id", {}, "path")],
        responses: { "200": { description: "OK", content } } });
    expect((await check(spec, filter)).diagnostics).toEqual([]);
    content["application/json"] = {};
    expect((await check(spec, filter)).diagnostics).toEqual([]);
});
test.each([limit, sorting, filter])("%s reports necessary broken references for the rule, not the parser", async (id) => {
    for (const reference of ["#/missing", "external.yaml#/Missing", "#/x-loop"]) {
        const spec = document("openapi3", {});
        object(spec.paths)["/v1/users"] = { $ref: reference };
        spec["x-loop"] = { $ref: "#/x-loop" };
        const { diagnostics } = await check(spec, id);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("execution failed");
    }
});
test("selected invalid schema/enum declarations are explicit rule failures", async () => {
    const invalid = document("openapi3", { parameters: [
        parameter("openapi3", "sort_key"), parameter("openapi3", "sort_dir", { enum: "asc", default: "asc" }),
    ] });
    expect((await check(invalid, sorting)).diagnostics[0].message).toContain("execution failed");
    const noSchema = document("openapi3", { parameters: [{ name: "limit", in: "query", schema: null }] });
    expect((await check(noSchema, limit)).diagnostics[0].message).toContain("execution failed");
});
test("query checks do not mutate frozen documents", async () => {
    const freeze = (value: unknown) => {
        if (value && typeof value === "object" && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const child of Object.values(value)) freeze(child);
        }
    };
    for (const dialect of ["swagger2", "openapi3"] satisfies Dialect[]) {
        const spec = document(dialect, {
            parameters: [parameter(dialect, "limit", { default: 1000 }), ...sortParams(dialect),
                parameter(dialect, "user_id", {}, "path")],
            responses: { "200": response(dialect, { type: "object", properties: { user_id: { type: "string" } } }) },
        });
        freeze(spec);
        const before = JSON.stringify(spec);
        for (const [id, fn] of [
            [limit, functionsMap.checkDefaultLimitValue], [sorting, functionsMap.checkSortingParams],
            [filter, functionsMap.checkURIFilterParams],
        ] as const) {
            const rule = rules.get(id);
            if (!rule) throw new Error(`Missing rule ${id}`);
            expect(await fn(spec, before, rule)).toEqual([]);
            expect(JSON.stringify(spec)).toBe(before);
        }
    }
});
