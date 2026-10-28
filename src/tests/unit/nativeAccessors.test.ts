import { classifyNativeOpenApiDocument, parseNativeOpenApi } from "@/lib/openapi/parseNativeOpenApi";
import { collectNativeOperations } from "@/lib/openapi/operations";
import {
    collectEffectiveParameterNodes, collectNativeParameters, getParameterSchema,
} from "@/lib/openapi/parameters";
import { jsonPointer, resolveReference } from "@/lib/openapi/references";
import { collectOperationMethods, collectQueryParams } from "@/utils/scan";
import { collectOperationParameters, collectOperations } from "@/utils/spec";
import { matchParameterSchema } from "@/utils/schema";
import { readFixtureContent, type Dialect } from "../fixtures/dual-version/scenarios";

function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}

function documentFor(dialect: Dialect, fields: Record<string, unknown>) {
    return classifyNativeOpenApiDocument({
        ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        ...fields,
    });
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s native accessors", (dialect) => {
    test.each(["", "-form-data", "-reusables", "-inheritance"])(
        "reads native fixture %s without mutation or conversion", (suffix) => {
            const content = readFixtureContent(dialect, suffix);
            const native = parseNativeOpenApi(content);
            freeze(native.document);
            const before = JSON.stringify(native.document);
            const operations = collectNativeOperations(native);
            expect(operations.length).toBeGreaterThan(0);
            for (const operation of operations) {
                expect(resolveReference(operation.pointer, native.document).value).toBe(operation.operation);
                for (const param of collectNativeParameters(native, operation)) {
                    expect(resolveReference(param.pointer, native.document).value).toBe(param.parameter);
                    if (param.schema) {
                        expect(resolveReference(param.schema.pointer, native.document).value).toBe(param.schema.node);
                    }
                }
            }
            expect(JSON.stringify(native.document)).toBe(before);
            expect(native.originalContent).toBe(content);
        },
    );

    test("merges inherited and operation parameters with stable order and exact provenance", () => {
        const native = parseNativeOpenApi(readFixtureContent(dialect, "-reusables"));
        freeze(native.document);
        const [operation, inheritedOperation] = collectNativeOperations(native);
        const params = collectNativeParameters(native, operation);
        expect(params.map((p) => p.name)).toEqual(["resource_id", "limit"]);
        expect(params.map((p) => p.level)).toEqual(["path", "operation"]);
        expect(params.map((p) => p.index)).toEqual([0, 0]);
        const idRoot = dialect === "swagger2" ? ["parameters"] : ["components", "parameters"];
        expect(params[0].resolvedPointer).toBe(jsonPointer([...idRoot, "ResourceId"]));
        expect(params[0].pointer).toBe(jsonPointer(["paths", operation.path, "parameters", 0]));
        expect(params[0].raw).toEqual({ $ref: jsonPointer([...idRoot, "ResourceId"]) });
        expect(params[1].schema?.node.default).toBe(25);
        expect(params[1].pointer).toBe(jsonPointer(["paths", operation.path, "get", "parameters", 0]));
        const inherited = collectNativeParameters(native, inheritedOperation);
        expect(inherited[1].schema?.node.default).toBe(1000);
        expect(params[1].parameter).not.toBe(inherited[1].parameter);
    });

    test("distinguishes real methods from metadata and preserves method filters", () => {
        const get = {}, trace = {};
        const native = documentFor(dialect, {
            paths: {
                "x-summary": { get: {} },
                "/resources": {
                    parameters: [{ name: "q", in: "query" }], summary: {}, description: {},
                    servers: [{}], "x-operation": {}, get, post: [], HEAD: {}, trace,
                },
                "/invalid": [],
            },
        });
        const methods = dialect === "swagger2" ? ["get", "head"] : ["get", "head", "trace"];
        expect(collectNativeOperations(native).map((op) => op.method)).toEqual(methods);
        expect(collectOperations(native.document).map((op) => op.method)).toEqual(methods);
        expect(collectOperationMethods(native.document).map((op) => op.method)).toEqual(["get"]);
        expect(collectOperationMethods(native.document, ["HEAD"]).map((op) => op.method)).toEqual(["head"]);
        expect(collectOperationMethods(native.document, []).map((op) => op.method)).toEqual([]);
        expect(collectNativeOperations(native, ["TRACE"]).map((op) => op.method))
            .toEqual(dialect === "swagger2" ? [] : ["trace"]);
        expect(collectNativeOperations(native)[0].operation).toBe(get);
    });

    test("resolves reusable path items and retains original path and target pointers", () => {
        const operation = { parameters: [{ name: "q", in: "query", type: "string" }] };
        const pathItem = { get: operation };
        const native = documentFor(dialect, {
            paths: { "/alias": { $ref: "#/x-paths/Shared" } }, "x-paths": { Shared: pathItem },
        });
        const [op] = collectNativeOperations(native);
        expect(op.path).toBe("/alias");
        expect(op.pathItemPointer).toBe("#/paths/~1alias");
        expect(op.resolvedPathItemPointer).toBe("#/x-paths/Shared");
        expect(op.pointer).toBe("#/x-paths/Shared/get");
        expect(op.pathItem).toBe(pathItem);
        expect(op.operation).toBe(operation);
        expect(collectNativeParameters(native, op)[0].pointer).toBe("#/x-paths/Shared/get/parameters/0");
    });

    test("does not silently discard Path Item $ref siblings", () => {
        const native = documentFor(dialect, {
            paths: { "/alias": { $ref: "#/x-paths/Shared", parameters: [{ name: "q", in: "query" }] } },
            "x-paths": { Shared: { get: {} } },
        });
        expect(() => collectNativeOperations(native))
            .toThrow(expect.objectContaining({ code: "INVALID_REFERENCE", pointer: "#/paths/~1alias" }));
        expect(collectOperationMethods(native.document, [])).toEqual([]);
    });

    test("reference errors retain the original parameter declaration pointer", () => {
        const native = documentFor(dialect, {
            paths: { "/resources": { parameters: [{ $ref: "#/missing" }], get: {} } },
        });
        expect(() => collectNativeParameters(native, collectNativeOperations(native)[0]))
            .toThrow(expect.objectContaining({
                code: "UNRESOLVED_REFERENCE", pointer: "#/paths/~1resources/parameters/0",
            }));
    });

    test("matches native parameter types and chained schema refs without changing matching policy", () => {
        const schema = { type: "string" };
        const param = {
            name: "X-Token", in: "header", required: true, description: "Token",
            ...(dialect === "swagger2" ? schema : { schema: { $ref: "#/x-schemas/String" } }),
        };
        const native = documentFor(dialect, {
            "x-parameters": { Alias: { $ref: "#/x-parameters/Token" }, Token: param },
            "x-schemas": { String: schema },
        });
        const raw = { $ref: "#/x-parameters/Alias" };
        expect(matchParameterSchema(raw, "x-token", "header", "string", native.document, {
            required: true, description: true,
        })).toBe(true);
        expect(matchParameterSchema(raw, "x-token", "header", "integer", native.document)).toBe(false);
        expect(matchParameterSchema(raw, "x-token", "header", "string", native.document, { required: false }))
            .toBe(false);
        expect(matchParameterSchema(raw, "x-token", "header", "string", native.document, { style: "simple" }))
            .toBe(false);
        expect(matchParameterSchema({ ...param, in: "query" }, "x-token", "query", "string", native.document))
            .toBe(false);
    });

    test("ordinary parameters retain native facets and serialization metadata", () => {
        const facets = { type: "array", items: { type: "integer" }, enum: [[1, 2]], default: [1] };
        const param = {
            name: "ids", in: "query",
            ...(dialect === "swagger2" ? { ...facets, collectionFormat: "csv" }
                : { schema: facets, style: "form", explode: false }),
        };
        const native = documentFor(dialect, { paths: { "/resources": { get: { parameters: [param] } } } });
        freeze(native.document);
        const [descriptor] = collectNativeParameters(native, collectNativeOperations(native)[0]);
        expect(descriptor.kind).toBe("parameter");
        expect(descriptor.schema?.node).toBe(dialect === "swagger2" ? param : facets);
        expect(descriptor.schema?.node).toMatchObject(facets);
        expect(descriptor.collectionFormat).toBe(dialect === "swagger2" ? "csv" : undefined);
        expect(descriptor.style).toBe(dialect === "swagger2" ? undefined : "form");
        expect(descriptor.explode).toBe(dialect === "swagger2" ? undefined : false);
        expect(Object.prototype.hasOwnProperty.call(param, "schema")).toBe(dialect !== "swagger2");
    });
});

test("Swagger body containers and formData are not synthesized into requestBody or payload fields", () => {
    const bodySchema = { type: "object", properties: { value: { type: "string" } } };
    const body = { name: "body_container", in: "body", schema: bodySchema };
    const native = documentFor("swagger2", { paths: { "/resources": { post: { parameters: [body] } } } });
    freeze(native.document);
    const [descriptor] = collectNativeParameters(native, collectNativeOperations(native)[0]);
    expect(descriptor.kind).toBe("body");
    expect(descriptor.parameter).toBe(body);
    expect(descriptor.schema?.node).toBe(bodySchema);
    expect(descriptor.schema?.pointer).toBe("#/paths/~1resources/post/parameters/0/schema");
    expect(JSON.stringify(native.document)).not.toMatch(/requestBody|"content"/);
    const form = parseNativeOpenApi(readFixtureContent("swagger2", "-form-data"));
    const fields = collectNativeParameters(form, collectNativeOperations(form)[0]);
    expect(fields.map((p) => [p.name, p.kind, p.schema?.node.type]))
        .toEqual([["file", "formData", "file"], ["caption", "formData", "string"]]);
});

test.each(["application/json", "application/xml", "text/plain"])(
    "OpenAPI content parameter supports %s and schema refs", (mediaType) => {
        const schema = { type: "integer", default: 3 };
        const param = {
            name: "q", in: "query", content: { [mediaType]: { schema: { $ref: "#/components/schemas/Value" } } },
        };
        const native = documentFor("openapi3", {
            components: { schemas: { Value: schema } },
            paths: { "/resources": { get: { parameters: [param] } } },
        });
        const [descriptor] = collectNativeParameters(native, collectNativeOperations(native)[0]);
        expect(descriptor.schema).toEqual({ node: schema, pointer: "#/components/schemas/Value" });
        expect(descriptor.schema?.node).toBe(schema);
        expect(matchParameterSchema(param, "q", "query", "integer", native.document)).toBe(true);
    },
);

test("inline content schema retains its exact media-type pointer", () => {
    const schema = { type: "string" };
    const param = { name: "q", in: "query", content: { "text/plain": { schema } } };
    const document = { openapi: "3.0.3" };
    expect(getParameterSchema(param, document, undefined, "#/parameters/0")).toEqual({
        node: schema, pointer: "#/parameters/0/content/text~1plain/schema",
    });
});

test("effective parameters override only the exact (in,name) pair, retaining both original nodes", () => {
    const pathQuery = { name: "q", in: "query", required: false };
    const pathHeader = { name: "q", in: "header", required: true };
    const opQuery = { name: "q", in: "query", required: true };
    const pathItem = { parameters: [pathQuery, pathHeader] };
    const operation = { parameters: [opQuery, { name: "Q", in: "query" }] };
    freeze(pathItem);
    freeze(operation);
    const merged = collectEffectiveParameterNodes(pathItem, operation, {});
    expect(merged.map((p) => [p.parameter.in, p.parameter.name, p.level]))
        .toEqual([["query", "q", "operation"], ["header", "q", "path"], ["query", "Q", "operation"]]);
    expect(merged[0].parameter).toBe(opQuery);
    expect(pathItem.parameters[0]).toBe(pathQuery);
    expect(collectOperationParameters(pathItem, operation, {}, new Map(), { query: true }))
        .toEqual([{ name: "q", required: true, in: "query" }, { name: "Q", required: false, in: "query" }]);
});

test("sorting adapter drops overridden definitions while retaining effective sequence and raw identity", () => {
    const oldDir = { name: "sort_dir", in: "query", schema: { default: "bad" } };
    const newDir = { name: "sort_dir", in: "query", schema: { default: "asc" } };
    const key = { name: "sort_key", in: "query" };
    const result = collectQueryParams({ parameters: [key, oldDir] }, { parameters: [newDir] }, {}, new Map());
    expect(result).toEqual([
        { name: "sort_key", index: 0, raw: key }, { name: "sort_dir", index: 1, raw: newDir },
    ]);
    expect(result[1].raw).toBe(newDir);
});

test("native and legacy parameter accessors surface missing/external/bad-target refs explicitly", () => {
    const document = { openapi: "3.0.3", scalar: false };
    for (const reference of ["#/missing", "other.yaml#/Parameter", "#/scalar"]) {
        const param = { $ref: reference };
        expect(() => getParameterSchema(param, document)).toThrow();
        expect(() => matchParameterSchema(param, "q", "query", "string", document)).toThrow();
        expect(() => collectEffectiveParameterNodes({}, { parameters: [param] }, document)).toThrow();
        expect(() => getParameterSchema({ name: "q", in: "query", schema: param }, document)).toThrow();
        const native = documentFor("openapi3", { scalar: false, paths: { "/alias": param } });
        expect(() => collectNativeOperations(native)).toThrow();
    }
});
