import fs from "node:fs/promises";
import path from "node:path";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import {
    array, collectionPath, detailPath, object, readFixture, readFixtureContent, schemas, responseSchema,
    type Dialect, type JsonObject, type JsonValue,
} from "../fixtures/dual-version/scenarios";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Fixture tests must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Fixture tests must not convert documents."); }),
}), { virtual: true });

const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
const dialects: Dialect[] = ["swagger2", "openapi3"];
const suffixes = ["", "-form-data", "-reusables", "-inheritance"];
let complianceRules: AutoRule[];

beforeAll(async () => {
    const root = path.join(process.cwd(), "public/rulesets/default");
    const catalog = await loadRuleCatalog([path.join(root, "OAS_Compliance.yaml")], (file) => fs.readFile(file, "utf8"));
    complianceRules = getImplementedRules(catalog, functionsMap);
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network access is forbidden in fixture tests."));
});

afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

function expectSchemaPair(swagger: JsonValue, openapi: JsonValue): void {
    if (Array.isArray(swagger)) {
        const other = array(openapi);
        expect(other).toHaveLength(swagger.length);
        swagger.forEach((value, index) => expectSchemaPair(value, other[index]));
    } else if (swagger && typeof swagger === "object") {
        const other = object(openapi);
        expect(Object.keys(other).sort()).toEqual(Object.keys(swagger).sort());
        for (const [key, value] of Object.entries(swagger)) {
            if (key === "$ref") {
                expect(typeof value).toBe("string");
                expect(other[key]).toBe(String(value).replace("#/definitions/", "#/components/schemas/"));
            } else expectSchemaPair(value, other[key]);
        }
    } else expect(openapi).toEqual(swagger);
}

function expectLocalRefsResolve(document: JsonObject, node: JsonValue = document): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        node.forEach((value) => expectLocalRefsResolve(document, value));
        return;
    }
    if (typeof node.$ref === "string") {
        expect(node.$ref).toMatch(/^#\//);
        let target: JsonValue = document;
        for (const encoded of node.$ref.slice(2).split("/")) {
            const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
            const container = object(target);
            expect(container).toHaveProperty([token]);
            target = container[token];
        }
        expect(target).toBeDefined();
    }
    Object.values(node).forEach((value) => expectLocalRefsResolve(document, value));
}

describe.each(suffixes)("paired fixture %s", (suffix) => {
    test("describes the same API operations using two independently authored native documents", () => {
        const swagger = readFixture("swagger2", suffix);
        const openapi = readFixture("openapi3", suffix);
        expect(swagger.swagger).toBe("2.0");
        expect(openapi.openapi).toBe("3.0.3");
        expect(swagger.info).toEqual(openapi.info);
        expect(Object.keys(object(swagger.paths))).toEqual(Object.keys(object(openapi.paths)));
        for (const [pathKey, pathItem] of Object.entries(object(swagger.paths))) {
            const counterpart = object(object(openapi.paths)[pathKey]);
            expect(Object.keys(object(pathItem))).toEqual(Object.keys(counterpart));
            for (const [method, operation] of Object.entries(object(pathItem))) {
                if (method === "parameters") continue;
                expect(object(operation).operationId).toBe(object(counterpart[method]).operationId);
                expect(Object.keys(object(object(operation).responses))).toEqual(
                    Object.keys(object(object(counterpart[method]).responses))
                );
            }
        }
        if (suffix !== "-form-data") expectSchemaPair(schemas(swagger, "swagger2"), schemas(openapi, "openapi3"));
    });

    for (const dialect of dialects) {
        test.each(["yaml", "json"])(`${dialect} %s retains native structure and passes format compliance`, async (encoding) => {
            const spec = readFixture(dialect, suffix);
            const content = encoding === "json" ? JSON.stringify(spec) : readFixtureContent(dialect, suffix);
            const { diagnostics } = await runLinter(content, complianceRules);
            expect(diagnostics).toEqual([]);
            expectLocalRefsResolve(spec);
            if (dialect === "swagger2") {
                expect(spec).not.toHaveProperty("openapi");
                expect(spec).not.toHaveProperty("components");
            } else {
                expect(spec).not.toHaveProperty("swagger");
                expect(spec).not.toHaveProperty("definitions");
            }
        });
    }
});

test("base fixtures contain real collection/detail responses, a body, and matching explicit payload examples", () => {
    const swagger = readFixture("swagger2");
    const openapi = readFixture("openapi3");
    const swaggerPaths = object(swagger.paths);
    const openapiPaths = object(openapi.paths);
    const swaggerPost = object(object(swaggerPaths[collectionPath]).post);
    const openapiPost = object(object(openapiPaths[collectionPath]).post);
    const body = array(swaggerPost.parameters).map(object).find((parameter) => parameter.in === "body");
    expect(body).toMatchObject({ name: "body", required: true, schema: { $ref: "#/definitions/ResourceRequest" } });
    const requestMedia = object(object(object(openapiPost.requestBody).content)["application/json"]);
    expect(object(schemas(swagger, "swagger2").ResourceRequest).example).toEqual(requestMedia.example);
    for (const [pathKey, method, status] of [
        [collectionPath, "get", "200"], [collectionPath, "post", "201"], [detailPath, "get", "200"],
    ]) {
        const v2Response = object(object(object(object(swaggerPaths[pathKey])[method]).responses)[status]);
        const v3Response = object(object(object(object(openapiPaths[pathKey])[method]).responses)[status]);
        expectSchemaPair(responseSchema(v2Response, "swagger2"), responseSchema(v3Response, "openapi3"));
        expect(object(v2Response.examples)["application/json"])
            .toEqual(object(object(v3Response.content)["application/json"]).example);
    }
});

test("form fixtures represent native files, required form fields, and effective operation MIME overrides", () => {
    const swagger = readFixture("swagger2", "-form-data");
    const openapi = readFixture("openapi3", "-form-data");
    expect(swagger.consumes).toEqual(["application/json"]);
    expect(swagger.produces).toEqual(["application/json"]);
    const upload = object(object(object(swagger.paths)["/v1/uploads"]).post);
    expect(upload.consumes).toEqual(["multipart/form-data"]);
    expect(upload.produces).toEqual(["text/plain"]);
    expect(array(upload.parameters)).toContainEqual({ name: "file", in: "formData", required: true, type: "file" });
    expect(upload).not.toHaveProperty("requestBody");
    const v3Upload = object(object(object(openapi.paths)["/v1/uploads"]).post);
    const multipart = object(object(object(v3Upload.requestBody).content)["multipart/form-data"]);
    expect(object(multipart.schema).required).toEqual(["file"]);
    expect(object(object(multipart.schema).properties).file).toEqual({ type: "string", format: "binary" });
    const metadata = object(object(object(swagger.paths)["/v1/metadata"]).post);
    expect(metadata.consumes).toEqual(["application/x-www-form-urlencoded"]);
    expect(metadata).not.toHaveProperty("produces");
    const v3Metadata = object(object(object(openapi.paths)["/v1/metadata"]).post);
    expect(object(object(v3Metadata.requestBody).content)).toHaveProperty("application/x-www-form-urlencoded");
    expect(object(object(object(v3Metadata.responses)["200"]).content)).toHaveProperty("application/json");
});

test("reusable fixtures retain root containers, chained refs, path inheritance, and operation overrides", () => {
    for (const dialect of dialects) {
        const spec = readFixture(dialect, "-reusables");
        const containers = dialect === "swagger2" ? spec : object(spec.components);
        const reusableParameters = object(containers.parameters);
        const limit = object(reusableParameters.Limit);
        expect(dialect === "swagger2" ? limit.default : object(limit.schema).default).toBe(1000);
        const pathItem = object(object(spec.paths)[detailPath]);
        expect(array(pathItem.parameters)).toHaveLength(2);
        const getLimit = object(array(object(pathItem.get).parameters)[0]);
        expect(dialect === "swagger2" ? getLimit.default : object(getLimit.schema).default).toBe(25);
        expect(object(pathItem.delete)).not.toHaveProperty("parameters");
        const response = object(object(object(pathItem.get).responses)["200"]);
        expect(response.$ref).toBe(`#/${dialect === "swagger2" ? "" : "components/"}responses/ResourceResponse`);
        expect(object(schemas(spec, dialect).ResourceAlias).$ref)
            .toBe(`#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/Resource`);
        const security = object(dialect === "swagger2" ? spec.securityDefinitions : containers.securitySchemes);
        expect(security.Token).toEqual({ type: "apiKey", name: "X-Auth-Token", in: "header" });
    }
});

test("inheritance fixtures retain allOf and RFC 6901 escaped property refs in valid schema containers", () => {
    for (const dialect of dialects) {
        const spec = readFixture(dialect, "-inheritance");
        const definitions = schemas(spec, dialect);
        const resource = object(definitions.Resource);
        expect(array(resource.allOf)).toHaveLength(2);
        expect(object(array(resource.allOf)[0]).$ref)
            .toBe(`#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/BaseResource`);
        expect(object(definitions.ResourceName).$ref).toContain("/properties/label~1name~0");
        expect(object(object(definitions.ResourceMeta).properties)["label/name~"]).toEqual({ type: "string" });
        expectLocalRefsResolve(spec);
    }
});
