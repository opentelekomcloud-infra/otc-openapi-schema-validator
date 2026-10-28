import { classifyNativeOpenApiDocument, parseNativeOpenApi } from "@/lib/openapi/parseNativeOpenApi";
import { collectNativeOperations } from "@/lib/openapi/operations";
import {
    getNativeRequest, getNativeResponse, getResponseMediaMatch, matchResponseContentTypes, selectPayloadSchema,
} from "@/lib/openapi/payloads";
import { getNativeTransport } from "@/lib/openapi/transport";
import { getNativeSchemas } from "@/lib/openapi/schemas";
import { getEffectiveStringList } from "@/lib/openapi/media";
import { validateRequestExamples } from "@/utils/validation";
import {
    getRequestBodySchema, getResponseContentMatch, getResponseSchema, getResponseSchemaByStatus,
} from "@/utils/schema";
import { readFixtureContent, type Dialect } from "../fixtures/dual-version/scenarios";

function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}

function nativeFor(dialect: Dialect, fields: Record<string, unknown>) {
    return classifyNativeOpenApiDocument({
        ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }), ...fields,
    });
}

describe.each<Dialect>(["swagger2", "openapi3"])("%s payload descriptors", (dialect) => {
    test.each(["", "-form-data", "-reusables", "-inheritance"])(
        "preserves native nodes, text and provenance in %s fixtures", (suffix) => {
            const native = parseNativeOpenApi(readFixtureContent(dialect, suffix));
            freeze(native.document);
            const before = JSON.stringify(native.document);
            for (const op of collectNativeOperations(native)) {
                const request = getNativeRequest(native, op);
                if (request.kind === "body") {
                    expect(request.body.node).toBeTruthy();
                    expect(request.body.pointer).toMatch(/^#\//);
                    const selected = selectPayloadSchema(request, ["application/json"], native.document);
                    if (selected) expect(selected.node).toBeTruthy();
                }
                for (const status of Object.keys(op.operation.responses ?? {})) {
                    const response = getNativeResponse(native, op, status);
                    expect(response?.statusCode).toBe(status);
                    expect(response?.response.pointer).toContain("/responses/");
                    expect(response?.response.node).toBeTruthy();
                    const selected = selectPayloadSchema(response, ["application/json"], native.document);
                    if (selected) expect(selected.pointer).toMatch(/^#\//);
                }
            }
            getNativeSchemas(native);
            expect(JSON.stringify(native.document)).toBe(before);
            expect(native.originalContent).toBe(readFixtureContent(dialect, suffix));
        },
    );

    test("resolves reusable responses without losing original declaration and target pointers", () => {
        const native = parseNativeOpenApi(readFixtureContent(dialect, "-reusables"));
        const op = collectNativeOperations(native)[0];
        const response = getNativeResponse(native, op, "200");
        expect(response?.response.raw).toHaveProperty("$ref");
        expect(response?.response.pointer).toBe(op.pointer + "/responses/200");
        expect(response?.response.resolvedPointer).toBe(
            dialect === "swagger2" ? "#/responses/ResourceResponse" : "#/components/responses/ResourceResponse",
        );
        const schema = selectPayloadSchema(response, ["application/json"], native.document);
        expect(schema?.pointer).toBe(
            dialect === "swagger2" ? "#/definitions/Resource" : "#/components/schemas/Resource",
        );
        expect(schema?.node).toMatchObject({ type: "object", required: ["resource_id"] });
        expect(matchResponseContentTypes(response, ["application/json"])).toBe("match");
    });

    test("global schema descriptors resolve aliases while preserving their declarations", () => {
        const native = parseNativeOpenApi(readFixtureContent(dialect, "-reusables"));
        const entries = getNativeSchemas(native);
        const alias = entries.find((entry) => entry.name === "ResourceAlias");
        const resource = entries.find((entry) => entry.name === "Resource");
        expect(alias?.raw).toHaveProperty("$ref");
        expect(alias?.node).toBe(resource?.node);
        expect(alias?.resolvedPointer).toBe(resource?.pointer);
    });

    test("empty, missing and malformed schema containers remain distinct", () => {
        expect(getNativeSchemas(nativeFor(dialect, {}))).toEqual([]);
        const fields = dialect === "swagger2" ? { definitions: [] } : { components: { schemas: [] } };
        expect(() => getNativeSchemas(nativeFor(dialect, fields)))
            .toThrow(expect.objectContaining({ code: "INVALID_DECLARATION" }));
    });
});

test("Swagger request body inheritance, refs and operation override retain original schema identity", () => {
    const inheritedSchema = { type: "array", items: { type: "object" } };
    const overrideSchema = { type: "object", properties: { resources: inheritedSchema } };
    const inherited = { name: "body", in: "body", required: true, schema: inheritedSchema };
    const override = { name: "body", in: "body", schema: overrideSchema };
    const native = nativeFor("swagger2", {
        consumes: ["application/json"], parameters: { Body: inherited },
        paths: { "/resources": { parameters: [{ $ref: "#/parameters/Body" }], post: {}, put: { parameters: [override] } } },
    });
    freeze(native.document);
    const [post, put] = collectNativeOperations(native);
    const first = getNativeRequest(native, post);
    const second = getNativeRequest(native, put);
    expect(first.kind).toBe("body");
    if (first.kind !== "body" || second.kind !== "body") throw new Error("Expected body descriptors");
    expect(first.body.raw).toEqual({ $ref: "#/parameters/Body" });
    expect(first.body.node).toBe(inherited);
    expect(first.body.resolvedPointer).toBe("#/parameters/Body");
    expect(first.schema?.node).toBe(inheritedSchema);
    expect(first.required).toBe(true);
    expect(second.schema?.node).toBe(overrideSchema);
    expect(second.body.pointer).toBe("#/paths/~1resources/put/parameters/0");
    expect(getRequestBodySchema(post.operation, native.document, new Map(), undefined, post.pathItem))
        .toBe(inheritedSchema);
});

test("OpenAPI requestBody refs and schema refs preserve media/declaration/target provenance", () => {
    const schema = { type: "object" };
    const body = { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Body" } } } };
    const native = nativeFor("openapi3", {
        paths: { "/resources": { post: { requestBody: { $ref: "#/components/requestBodies/Alias" } } } },
        components: { requestBodies: { Alias: { $ref: "#/components/requestBodies/Body" }, Body: body }, schemas: { Body: schema } },
    });
    freeze(native.document);
    const request = getNativeRequest(native, collectNativeOperations(native)[0]);
    if (request.kind !== "body") throw new Error("Expected a body");
    expect(request.body.node).toBe(body);
    expect(request.body.pointer).toBe("#/paths/~1resources/post/requestBody");
    expect(request.body.resolvedPointer).toBe("#/components/requestBodies/Body");
    expect(request.media[0].node).toBe(body.content["application/json"]);
    expect(request.media[0].schema?.pointer).toBe("#/components/requestBodies/Body/content/application~1json/schema");
    expect(selectPayloadSchema(request, ["application/json"], native.document)).toEqual({
        node: schema, pointer: "#/components/schemas/Body",
    });
});

test.each(["consumes", "produces", "schemes"] as const)(
    "Swagger %s preserves root inheritance, explicit override, empty override and absence", (field) => {
        const root = { [field]: ["root"] };
        const override = { [field]: ["operation"] };
        expect(getEffectiveStringList(root, {}, field)).toMatchObject({
            state: "declared", values: ["root"], pointer: `#/${field}`, level: "root",
        });
        expect(getEffectiveStringList(root, override, field, "#/paths/~1resources/post")).toMatchObject({
            values: ["operation"], pointer: `#/paths/~1resources/post/${field}`, level: "operation",
        });
        expect(getEffectiveStringList(root, { [field]: [] }, field)).toMatchObject({ state: "declared", values: [] });
        expect(getEffectiveStringList({}, {}, field)).toEqual({ state: "unspecified", values: [] });
        expect(() => getEffectiveStringList(root, { [field]: null }, field))
            .toThrow(expect.objectContaining({ code: "INVALID_DECLARATION" }));
    },
);

test.each([undefined, [], ["application/json"], ["text/plain"]])(
    "Swagger response media declaration %j produces an honest tri-state match", (produces) => {
        const operation = { responses: { "200": { schema: { type: "object" } } } };
        const native = nativeFor("swagger2", {
            ...(produces === undefined ? {} : { produces }), paths: { "/resources": { get: operation } },
        });
        const payload = getNativeResponse(native, collectNativeOperations(native)[0], "200");
        const expected = produces === undefined ? "unknown" : produces.includes("application/json") ? "match" : "mismatch";
        expect(matchResponseContentTypes(payload, ["application/json"])).toBe(expected);
        expect(getResponseContentMatch(operation, {}, native.document, new Map())).toBe(expected);
        expect(getResponseSchema(operation, native.document, new Map(), {})).toBe(operation.responses["200"].schema);
        expect(payload?.mediaTypes.state).toBe(produces === undefined ? "unspecified" : "declared");
    },
);

test("formData stays fields, not a fabricated object schema or requestBody", () => {
    const native = parseNativeOpenApi(readFixtureContent("swagger2", "-form-data"));
    freeze(native.document);
    const request = getNativeRequest(native, collectNativeOperations(native)[0]);
    expect(request.kind).toBe("formData");
    if (request.kind !== "formData") throw new Error("Expected formData");
    expect(request.fields.map((field) => [field.name, field.schema?.node.type])).toEqual([
        ["file", "file"], ["caption", "string"],
    ]);
    expect(request.mediaTypes.values).toEqual(["multipart/form-data"]);
    expect(selectPayloadSchema(request, ["application/json"], native.document)).toBeUndefined();
    expect(JSON.stringify(native.document)).not.toMatch(/requestBody|"content"/);
});

test("existing example validation receives inherited native body schema without synthesizing examples", () => {
    const body = { name: "body", in: "body", schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } };
    const problems = validateRequestExamples(
        {}, { parameters: [body] }, [{ source: "explicit schema.example", value: {} }], { swagger: "2.0" }, new Map(),
        { includeRequestBodySchema: true, requireRequiredBodyFields: true, forbidUndefinedFields: true },
    );
    expect(problems).toEqual(["Request example is missing required body field 'name'."]);
});

test.each(["multiple bodies", "mixed body/formData"])("conflicting Swagger payload: %s", (kind) => {
    const first = { name: "body", in: "body", schema: { type: "object" } };
    const second = kind === "multiple bodies" ? { ...first, name: "another" }
        : { name: "file", in: "formData", type: "file" };
    const native = nativeFor("swagger2", { paths: { "/resources": { post: { parameters: [first, second] } } } });
    expect(() => getNativeRequest(native, collectNativeOperations(native)[0]))
        .toThrow(expect.objectContaining({ code: "CONFLICTING_PAYLOAD" }));
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s malformed payload schemas", (dialect) => {
    test.each([null, false, [], "string"])("declared schema %j is an explicit error, not absent", (schema) => {
        const operation = dialect === "swagger2"
            ? { parameters: [{ name: "body", in: "body", schema }], responses: { "200": { schema } } }
            : { requestBody: { content: { "application/json": { schema } } }, responses: { "200": { content: { "application/json": { schema } } } } };
        const native = nativeFor(dialect, { paths: { "/resources": { post: operation } } });
        const op = collectNativeOperations(native)[0];
        expect(() => getNativeRequest(native, op)).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
        expect(() => getNativeResponse(native, op, "200")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
    });
});

test("media selectors preserve first-media versus first-schema policies and do not resolve unused refs", () => {
    const schema = { type: "object" };
    const operation = {
        requestBody: { content: { "application/json": {}, "application/xml": { schema } } },
        responses: {
            "200": { content: { "application/json": {}, "application/xml": { schema } } },
            "201": { content: { "application/json": { schema }, "text/plain": { schema: { $ref: "external.yaml" } } } },
        },
    };
    const document = { openapi: "3.0.3" };
    expect(getRequestBodySchema(operation, document, new Map())).toBeNull();
    expect(getResponseSchema(operation, document, new Map(), {})).toBeNull();
    expect(getResponseSchemaByStatus(operation, "200", document, new Map())).toBe(schema);
    expect(getResponseSchemaByStatus(operation, "201", document, new Map())).toBe(schema);
});

test("success helpers stay on 200 and do not broaden to 201/202 or default", () => {
    const schema = { type: "object" };
    const operation = { responses: { "201": { schema }, default: { schema } } };
    const document = { swagger: "2.0" };
    expect(getResponseSchema(operation, document, new Map(), {})).toBeNull();
    expect(getResponseSchemaByStatus(operation, "201", document, new Map())).toBe(schema);
    expect(getResponseSchemaByStatus(operation, "202", document, new Map())).toBeNull();
    expect(getResponseContentMatch(operation, {}, document, new Map())).toBe("mismatch");
});

test("a media gate reads response refs but does not dereference a schema for excluded MIME", () => {
    const document = {
        swagger: "2.0", produces: ["text/plain"],
        responses: { Body: { schema: { $ref: "external.yaml" } } },
    };
    const operation = { responses: { "200": { $ref: "#/responses/Body" } } };
    expect(getResponseMediaMatch(operation, "200", document, ["application/json"])).toBe("mismatch");
    expect(() => getResponseSchema(operation, document, new Map(), {}))
        .toThrow(expect.objectContaining({ code: "EXTERNAL_REFERENCE" }));
});

test.each(["#/missing", "external.yaml#/Schema", "#/Loop"])(
    "selected request/response schema ref %s fails explicitly", (reference) => {
        const schema = { $ref: reference };
        const document = { swagger: "2.0", Loop: { $ref: "#/Loop" } };
        const operation = { parameters: [{ name: "body", in: "body", schema }], responses: { "200": { schema } } };
        expect(() => getRequestBodySchema(operation, document, new Map())).toThrow();
        expect(() => getResponseSchema(operation, document, new Map(), {})).toThrow();
    },
);

test("OAS3 direct response.schema is not interpreted as Swagger schema", () => {
    expect(() => getResponseSchema({ responses: { "200": { schema: { type: "object" } } } }, { openapi: "3.0.3" }, new Map(), {}))
        .toThrow(expect.objectContaining({ code: "INVALID_DECLARATION" }));
});

test("Swagger transport retains unknown, root and operation overrides without assuming HTTPS", () => {
    const native = nativeFor("swagger2", {
        schemes: ["https"], paths: { "/resources": { get: {}, post: { schemes: ["http"] }, put: { schemes: [] } } },
    });
    const [get, post, put] = collectNativeOperations(native);
    expect(getNativeTransport(native, get)).toMatchObject({ kind: "schemes", declaration: { values: ["https"], level: "root" } });
    expect(getNativeTransport(native, post)).toMatchObject({ kind: "schemes", declaration: { values: ["http"], level: "operation" } });
    expect(getNativeTransport(native, put)).toMatchObject({ kind: "schemes", declaration: { values: [], level: "operation" } });
    expect(getNativeTransport(nativeFor("swagger2", {}))).toEqual({ kind: "unspecified" });
});

test.each(["/relative", "//relative.example.invalid", "{protocol}://example.invalid"])(
    "OAS3 server URL %s does not establish HTTPS", (url) => {
        const server = { url };
        const native = nativeFor("openapi3", {
            servers: [{ url: "https://root.example.invalid" }],
            paths: { "/resources": { servers: [server], get: {}, post: { servers: [] } } },
        });
        freeze(native.document);
        const [get, post] = collectNativeOperations(native);
        const transport = getNativeTransport(native, get);
        expect(transport.kind).toBe("servers");
        if (transport.kind !== "servers") throw new Error("Expected servers");
        expect(transport.level).toBe("path");
        expect(transport.servers[0].node).toBe(server);
        expect(transport.servers[0].scheme).toBeUndefined();
        expect(transport.servers[0].pointer).toBe("#/paths/~1resources/servers/0");
        expect(getNativeTransport(native, post)).toMatchObject({ kind: "servers", servers: [], level: "operation" });
    },
);

test("OAS3 transport preserves absolute schemes and does not invent a default server", () => {
    const native = nativeFor("openapi3", {
        servers: [{ url: "https://root.example.invalid" }],
        paths: { "/resources": { get: {}, post: { servers: [{ url: "http://op.example.invalid" }] } } },
    });
    const [get, post] = collectNativeOperations(native);
    expect(getNativeTransport(native, get)).toMatchObject({ level: "root", servers: [{ scheme: "https" }] });
    expect(getNativeTransport(native, post)).toMatchObject({ level: "operation", servers: [{ scheme: "http" }] });
    expect(getNativeTransport(nativeFor("openapi3", {}))).toEqual({ kind: "unspecified" });
    expect(() => getNativeTransport(nativeFor("openapi3", { servers: null })))
        .toThrow(expect.objectContaining({ code: "INVALID_DECLARATION" }));
    expect(() => getNativeSchemas(nativeFor("openapi3", { components: null })))
        .toThrow(expect.objectContaining({ code: "INVALID_DECLARATION" }));
});
