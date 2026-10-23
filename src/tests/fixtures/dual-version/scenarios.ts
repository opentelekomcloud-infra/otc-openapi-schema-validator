import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import type { AutoRule } from "@/lib/linter/ruleCatalog";

export type Dialect = "swagger2" | "openapi3";
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }
export type Variant = "positive" | "negative";
export const collectionPath = "/v1/resources";
export const detailPath = "/v1/resources/{resource_id}";

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.every(isJsonValue);
    return typeof value === "object" && value !== null &&
        Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJsonValue);
}

export function object(value: JsonValue | undefined): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Expected a fixture object.");
    }
    return value;
}

export function array(value: JsonValue | undefined): JsonValue[] {
    if (!Array.isArray(value)) throw new Error("Expected a fixture array.");
    return value;
}

export function readFixtureContent(dialect: Dialect, suffix = ""): string {
    return fs.readFileSync(path.join(__dirname, `${dialect}${suffix}.yaml`), "utf8");
}

export function readFixture(dialect: Dialect, suffix = ""): JsonObject {
    const parsed: unknown = yaml.load(readFixtureContent(dialect, suffix));
    if (!isJsonValue(parsed)) throw new Error(`Fixture is not JSON-compatible: ${dialect}${suffix}`);
    return object(parsed);
}

export function schemas(spec: JsonObject, dialect: Dialect): JsonObject {
    return dialect === "swagger2" ? object(spec.definitions) : object(object(spec.components).schemas);
}

export function schemaRef(dialect: Dialect, name: string): JsonObject {
    return { $ref: `#/${dialect === "swagger2" ? "definitions" : "components/schemas"}/${name}` };
}

export function parameter(
    dialect: Dialect, name: string, location: string, schema: JsonObject = { type: "string" }
): JsonObject {
    const common = { name, in: location, ...(location === "path" ? { required: true } : {}) };
    return dialect === "swagger2" ? { ...common, ...schema } : { ...common, schema };
}

export function responseSchema(response: JsonObject, dialect: Dialect): JsonObject {
    return dialect === "swagger2" ? object(response.schema)
        : object(object(object(response.content)["application/json"]).schema);
}

function setResponseSchema(response: JsonObject, dialect: Dialect, schema: JsonObject): void {
    if (dialect === "swagger2") response.schema = schema;
    else object(object(response.content)["application/json"]).schema = schema;
}

function requestSchema(dialect: Dialect, operation: JsonObject, schema: JsonObject): void {
    if (dialect === "swagger2") {
        const body = array(operation.parameters).map(object).find((param) => param.in === "body");
        if (!body) throw new Error("Missing fixture body parameter.");
        body.schema = schema;
    } else {
        object(object(object(operation.requestBody).content)["application/json"]).schema = schema;
    }
}

function strings(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw new Error("Expected string array in rule configuration.");
    }
    return value;
}

export interface ScenarioInput {
    spec: JsonObject;
    dialect: Dialect;
    variant: Variant;
    rule: AutoRule;
    operation: JsonObject;
    response: JsonObject;
    definitions: JsonObject;
    renamePath: (path: string) => void;
    changeMethod: (method: string) => void;
}

interface Scenario {
    positive: string;
    negative: string;
    message: string;
    method?: "get" | "post";
    detail?: boolean;
    baseline?: boolean;
    mixedBaselineGap?: { task: string; reason: string };
    idLocation?: "message";
    nativeV2?: { task: string; reason: string };
    prepare: (input: ScenarioInput) => void;
}

const bodyGap = (task: string) => ({ task: `T06/${task}`, reason: "Native body/response schema access is not implemented." });
const headerGap = { task: "T05/T10", reason: "Native v2 parameter types and body predicates are not implemented." };
const baselineGap = { task: "T18", reason: "Both baseline and current schemas must be read in their native dialects." };

export const scenarios = {
    examples: {
        positive: "GET response has a contract-compatible payload example",
        negative: "GET response payload example is absent",
        message: "Missing required response example",
        prepare: ({ response, dialect, variant }) => {
            if (variant === "negative") {
                if (dialect === "swagger2") delete response.examples;
                else delete object(object(response.content)["application/json"]).example;
            }
        },
    },
    versionPrefix: {
        positive: "info.version is v1", negative: "info.version is 1",
        message: "must start with 'v'",
        prepare: ({ spec, variant }) => { if (variant === "negative") object(spec.info).version = "1"; },
    },
    versionFormat: {
        positive: "info.version is v1", negative: "info.version is vNext",
        message: "does not match required format",
        prepare: ({ spec, variant }) => { if (variant === "negative") object(spec.info).version = "vNext"; },
    },
    versionSegments: {
        positive: "one API version segment", negative: "five API version segments",
        message: "exceeds the allowed maximum of 4",
        prepare: ({ spec, variant }) => {
            if (variant === "negative") object(spec.info).version = "v1.2.3.4.5";
        },
    },
    versionNormalized: {
        positive: "major-only API version", negative: "deprecated minor API version",
        message: "non-normalized",
        prepare: ({ spec, variant }) => { if (variant === "negative") object(spec.info).version = "v1.2"; },
    },
    breakingVersion: {
        positive: "unchanged operation and major API version",
        negative: "successful response code removed without increasing major API version",
        message: "major version was not increased", baseline: true,
        mixedBaselineGap: { task: "T18", reason: "Equivalent v2 produces and v3 content are incorrectly compared as media removal." },
        prepare: ({ operation, variant }) => {
            if (variant === "negative") operation.responses = { "400": { description: "Bad request" } };
        },
    },
    batchMethod: {
        positive: "keyword-detected batch operation uses POST",
        negative: "same batch operation uses PUT",
        message: "$rule", method: "post",
        prepare: ({ operation, variant, renamePath, changeMethod }) => {
            renamePath("/v1/resources/batch");
            operation.summary = "Batch resource creation";
            if (variant === "negative") changeMethod("put");
        },
    },
    batchPayload: {
        positive: "batch body contains an array of objects", negative: "batch body is a string",
        message: "Request body schema must be array<object>", method: "post",
        prepare: ({ dialect, operation, variant, renamePath }) => {
            renamePath("/v1/resources/batch");
            operation.summary = "Batch resource creation";
            requestSchema(dialect, operation, variant === "positive"
                ? { type: "array", items: { type: "object", properties: { name: { type: "string" } } } }
                : { type: "string" });
        },
    },
    batchSync: {
        positive: "synchronous batch list items expose status",
        negative: "synchronous batch list items have no status",
        message: "each item must expose a status field", method: "post",
        prepare: ({ operation, response, dialect, variant, renamePath }) => {
            renamePath("/v1/resources/batch");
            operation.summary = "Batch resource creation";
            operation.responses = { "200": response };
            setResponseSchema(response, dialect, {
                type: "object", properties: {
                    results: { type: "array", items: { type: "object", properties: variant === "positive"
                        ? { status: { type: "string" } } : { name: { type: "string" } } } },
                },
            });
        },
    },
    batchAsync: {
        positive: "202 batch response includes job_id", negative: "202 batch response has no job identifier",
        message: "Expected one of job identifier fields", method: "post",
        prepare: ({ operation, response, dialect, variant, renamePath }) => {
            renamePath("/v1/resources/batch");
            operation.summary = "Batch resource creation";
            operation.responses = { "202": response };
            setResponseSchema(response, dialect, { type: "object", properties: variant === "positive"
                ? { job_id: { type: "string" } } : { name: { type: "string" } } });
        },
    },
    commonName: {
        positive: "query parameter is named count", negative: "query parameter uses forbidden total_count",
        message: 'name "total_count" is not allowed',
        prepare: ({ operation, dialect, variant }) => {
            operation.parameters = [parameter(dialect, variant === "positive" ? "count" : "total_count", "query",
                { type: "integer" })];
        },
    },
    deletedOperation: {
        positive: "operation is retained", negative: "GET operation is removed",
        message: "was deleted in the new spec", baseline: true,
        prepare: ({ variant, changeMethod }) => { if (variant === "negative") changeMethod("head"); },
    },
    deletedProperty: {
        positive: "all response properties are retained", negative: "response resource_id is removed",
        message: 'property "resource_id"', baseline: true, detail: true, nativeV2: baselineGap,
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") {
                delete object(object(definitions.Resource).properties).resource_id;
                object(definitions.Resource).required = ["name"];
            }
        },
    },
    addedRequiredProperty: {
        positive: "request fields are unchanged", negative: "mandatory request field is added",
        message: 'property "region" was added', baseline: true, method: "post", nativeV2: baselineGap,
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") {
                object(object(definitions.ResourceRequest).properties).region = { type: "string" };
                object(definitions.ResourceRequest).required = ["resource", "region"];
            }
        },
    },
    changedPropertyType: {
        positive: "response property type is unchanged", negative: "resource_id changes from string to integer",
        message: 'changed from "string" to "integer"', baseline: true, detail: true, nativeV2: baselineGap,
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") object(object(object(definitions.Resource).properties).resource_id).type = "integer";
        },
    },
    narrowedEnum: {
        positive: "response enum values are retained", negative: "inactive is removed from response status enum",
        message: "Enum values removed", baseline: true, detail: true, nativeV2: baselineGap,
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") object(object(object(definitions.Resource).properties).status).enum = ["active"];
        },
    },
    deletedResponse: {
        positive: "200 response retained", negative: "200 response replaced with 400",
        message: "Response code 200 was deleted", baseline: true,
        prepare: ({ operation, variant }) => {
            if (variant === "negative") operation.responses = { "400": { description: "Bad request" } };
        },
    },
    deletedResponseHeader: {
        positive: "response headers retained", negative: "X-Request-Id response header removed",
        message: 'Response header "x-request-id" was deleted', baseline: true,
        prepare: ({ response, variant }) => {
            if (variant === "negative") delete object(response.headers)["X-Request-Id"];
        },
    },
    requiredHeader: {
        positive: "body and conditional header triggers are present; required headers exist",
        negative: "same triggers remain, required header and all configured alternatives are absent",
        message: "$rule", method: "post", nativeV2: headerGap,
        prepare: ({ operation, dialect, variant, rule }) => {
            const names = ["Content-Type", "Authorization", "X-Auth-Token", "X-SDK-Date", "Host", "X-Project-Id",
                "x-projectScenario", "X-Domain-Id", "X-Security-Token", "x-apigateway-ratelimit"];
            const params = rule.call.functionParams ?? {};
            const headers = params.headers;
            if (!Array.isArray(headers)) throw new Error("Missing configured fixture headers.");
            const requiredNames = headers.map((header: unknown) => {
                if (!header || typeof header !== "object" || !("name" in header) || typeof header.name !== "string") {
                    throw new Error("Invalid configured fixture header.");
                }
                return header.name;
            });
            const omitted = variant === "negative"
                ? [...requiredNames, ...strings(params.fallBackNames ?? [])] : [];
            operation.parameters = [
                ...array(operation.parameters),
                ...names.filter((name) => !omitted.includes(name)).map((name) => parameter(dialect, name, "header")),
            ];
        },
    },
    forbiddenHeader: {
        positive: "GET has no Content-Type parameter", negative: "GET declares Content-Type parameter",
        message: "$rule", nativeV2: headerGap,
        prepare: ({ operation, dialect, variant }) => {
            if (variant === "negative") operation.parameters = [parameter(dialect, "Content-Type", "header")];
        },
    },
    filterField: {
        positive: "path resource_id is present in response schema",
        negative: "path resource_id is absent from response schema",
        message: "Missing in response schema: resource_id", detail: true,
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") {
                delete object(object(definitions.Resource).properties).resource_id;
                object(definitions.Resource).required = ["name"];
            }
        },
    },
    https: {
        positive: "explicit HTTPS transport", negative: "explicit HTTP transport",
        message: "$rule", nativeV2: { task: "T10", reason: "schemes is not checked." },
        prepare: ({ spec, dialect, variant }) => {
            if (variant === "negative") {
                if (dialect === "swagger2") spec.schemes = ["http"];
                else spec.servers = [{ url: "http://fixtures.example.invalid/" }];
            }
        },
    },
    language: {
        positive: "English API title", negative: "Chinese characters in API title",
        message: "Non-English (Chinese) text detected",
        prepare: ({ spec, variant }) => {
            if (variant === "negative") object(spec.info).title = "\u4e2d\u6587";
        },
    },
    formatVersion: {
        positive: "native supported format marker", negative: "unsupported format marker",
        message: "$rule",
        prepare: ({ spec, dialect, variant }) => {
            if (variant === "negative") spec[dialect === "swagger2" ? "swagger" : "openapi"] =
                dialect === "swagger2" ? "1.2" : "3.1.1";
        },
    },
    rootStructure: {
        positive: "correct native top-level keys", negative: "required info object is absent",
        message: "$rule",
        prepare: ({ spec, variant }) => { if (variant === "negative") delete spec.info; },
    },
    pagination: {
        positive: "offset pagination includes limit", negative: "offset pagination omits limit",
        message: "$rule",
        prepare: ({ operation, dialect, variant }) => {
            operation.parameters = [parameter(dialect, "offset", "query", { type: "integer" })];
            if (variant === "positive") array(operation.parameters).push(parameter(dialect, "limit", "query", { type: "integer" }));
        },
    },
    limitDefault: {
        positive: "limit default is 1000", negative: "limit default is 25",
        message: "$rule",
        prepare: ({ operation, dialect, variant }) => {
            operation.parameters = [parameter(dialect, "limit", "query",
                { type: "integer", default: variant === "positive" ? 1000 : 25 })];
        },
    },
    snakeCase: {
        positive: "query parameter is resource_name", negative: "query parameter is resourceName",
        message: "resourceName",
        prepare: ({ operation, dialect, variant }) => {
            operation.parameters = [parameter(dialect, variant === "positive" ? "resource_name" : "resourceName", "query")];
        },
    },
    projectScope: {
        positive: "regional operation requires project_id path parameter",
        negative: "regional operation has no project_id path parameter",
        message: "$rule",
        prepare: ({ operation, dialect, variant, renamePath }) => {
            operation.tags = ["regional"];
            renamePath("/v1/{project_id}/resources");
            operation.parameters = variant === "positive" ? [parameter(dialect, "project_id", "path")] : [];
        },
    },
    reservedParameter: {
        positive: "reserved query field is explicitly marked and documented",
        negative: "reserved query field is documented but not marked",
        message: "future_filter",
        prepare: ({ operation, dialect, variant }) => {
            const param = parameter(dialect, "future_filter", "query");
            param.description = "Reserved for future use.";
            if (variant === "positive") param["x-reserved"] = true;
            operation.parameters = [param];
        },
    },
    rootName: {
        positive: "collection response root is resources",
        negative: "collection response root is unrelated data",
        message: "$rule", nativeV2: bodyGap("T12"),
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") {
                const list = object(definitions.ResourceList);
                const props = object(list.properties);
                props.data = props.resources;
                delete props.resources;
                list.required = ["data", "count"];
            }
        },
    },
    uriFormat: {
        positive: "URI starts with /v1", negative: "URI lacks leading API version",
        message: "must start with a version",
        prepare: ({ variant, renamePath }) => { if (variant === "negative") renamePath("/resources"); },
    },
    uriLength: {
        positive: "URI length is exactly 2048", negative: "URI length is 2049",
        message: "actual: 2049",
        prepare: ({ variant, renamePath }) => {
            renamePath("/v1/" + "a".repeat((variant === "positive" ? 2048 : 2049) - 4));
        },
    },
    uriDictionary: {
        positive: "resource name is an English word", negative: "resource name is an unknown abbreviation",
        message: "uncommon abbreviations",
        prepare: ({ variant, renamePath }) => { if (variant === "negative") renamePath("/v1/zzzxq"); },
    },
    uriSyntax: {
        positive: "URI uses lowercase hyphenated words", negative: "URI uses uppercase underscore syntax",
        message: "does not conform to the required URI syntax",
        prepare: ({ variant, renamePath }) => { if (variant === "negative") renamePath("/v1/Resource_Names"); },
    },
    uriSpecial: {
        positive: "URI contains no forbidden special characters", negative: "URI contains a dot",
        message: "$rule", idLocation: "message",
        prepare: ({ variant, renamePath }) => { if (variant === "negative") renamePath("/v1/resource.names"); },
    },
    uriUnicode: {
        positive: "URI contains only ASCII", negative: "URI contains a Unicode character",
        message: "$rule",
        prepare: ({ variant, renamePath }) => { if (variant === "negative") renamePath("/v1/r\u00e9sources"); },
    },
    uriPlural: {
        positive: "GET collection resource is plural", negative: "GET collection resource is singular",
        message: "should be plural",
        prepare: ({ variant, renamePath }) => { if (variant === "negative") renamePath("/v1/resource"); },
    },
    uriDepth: {
        positive: "URI has three resource levels", negative: "URI has four resource levels",
        message: "resource depth: 4",
        prepare: ({ variant, renamePath }) => {
            renamePath(variant === "positive" ? "/v1/resources/items/parts" : "/v1/resources/items/parts/values");
        },
    },
    crud: {
        positive: "POST collection has GET, PUT, DELETE", negative: "POST collection is missing DELETE",
        message: "Missing: delete", method: "post",
        prepare: ({ spec, variant }) => {
            const pathItem = object(object(spec.paths)[collectionPath]);
            pathItem.get = { responses: { "200": { description: "Resources" } } };
            pathItem.put = { responses: { "204": { description: "Updated" } } };
            if (variant === "positive") pathItem.delete = { responses: { "204": { description: "Deleted" } } };
        },
    },
    successCode: {
        positive: "GET has a 200 response", negative: "GET only has a 400 response",
        message: "$rule",
        prepare: ({ operation, variant }) => {
            if (variant === "negative") operation.responses = { "400": { description: "Bad request" } };
        },
    },
    getBody: {
        positive: "GET has no payload", negative: "GET declares a payload",
        message: "$rule", nativeV2: bodyGap("T11"),
        prepare: ({ dialect, operation, variant }) => {
            if (variant === "negative") {
                if (dialect === "swagger2") array(operation.parameters).push({
                    name: "body", in: "body", schema: schemaRef(dialect, "ResourceRequest"),
                });
                else operation.requestBody = {
                    content: { "application/json": { schema: schemaRef(dialect, "ResourceRequest") } },
                };
            }
        },
    },
    detailObject: {
        positive: "detail GET returns an object", negative: "detail GET returns a string",
        message: "$rule", detail: true, nativeV2: bodyGap("T11"),
        prepare: ({ response, dialect, variant }) => {
            if (variant === "negative") setResponseSchema(response, dialect, { type: "string" });
        },
    },
    collectionArray: {
        positive: "collection GET returns an object wrapping an array", negative: "collection GET returns a string",
        message: "$rule", nativeV2: bodyGap("T11"),
        prepare: ({ response, dialect, variant }) => {
            if (variant === "negative") setResponseSchema(response, dialect, { type: "string" });
        },
    },
    requestMedia: {
        positive: "POST consumes application/json", negative: "POST consumes text/plain",
        message: "$rule", method: "post", nativeV2: bodyGap("T11"),
        prepare: ({ dialect, operation, variant }) => {
            if (variant === "negative") {
                if (dialect === "swagger2") operation.consumes = ["text/plain"];
                else {
                    const content = object(object(operation.requestBody).content);
                    content["text/plain"] = content["application/json"];
                    delete content["application/json"];
                }
            }
        },
    },
    responseCount: {
        positive: "collection contains integer count", negative: "collection omits count",
        message: "$rule", nativeV2: bodyGap("T11"),
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") {
                delete object(object(definitions.ResourceList).properties).count;
                object(definitions.ResourceList).required = ["resources"];
            }
        },
    },
    quota: {
        positive: "GET /v1/quotas is present", negative: "only a resource collection GET is present",
        message: "$rule",
        prepare: ({ variant, renamePath }) => { if (variant === "positive") renamePath("/v1/quotas"); },
    },
    detailTimes: {
        positive: "detail schema exposes both created_at and updated_at",
        negative: "detail schema omits updated_at",
        message: "$rule", detail: true, nativeV2: bodyGap("T11"),
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") delete object(object(definitions.Resource).properties).updated_at;
        },
    },
    responseHeader: {
        positive: "response payload has X-Request-Id header", negative: "response payload lacks request ID headers",
        message: "Expected at least one of", nativeV2: bodyGap("T10"),
        prepare: ({ response, variant }) => {
            if (variant === "negative") delete object(response.headers)["X-Request-Id"];
        },
    },
    customHeader: {
        positive: "custom response header uses X-Request-Id", negative: "custom response header uses Bad_Header",
        message: 'Header "Bad_Header"',
        prepare: ({ response, variant }) => {
            if (variant === "negative") {
                const headers = object(response.headers);
                headers.Bad_Header = headers["X-Request-Id"];
                delete headers["X-Request-Id"];
            }
        },
    },
    responseMedia: {
        positive: "POST produces application/json", negative: "POST produces text/plain",
        message: "$rule", method: "post", nativeV2: bodyGap("T11"),
        prepare: ({ dialect, operation, response, variant }) => {
            if (variant === "negative") {
                if (dialect === "swagger2") operation.produces = ["text/plain"];
                else {
                    const content = object(response.content);
                    content["text/plain"] = content["application/json"];
                    delete content["application/json"];
                }
            }
        },
    },
    sensitiveQuery: {
        positive: "path parameter contains no sensitive name", negative: "path parameter is named password",
        message: "$rule", nativeV2: headerGap,
        prepare: ({ operation, dialect, variant, renamePath }) => {
            const name = variant === "positive" ? "name" : "password";
            renamePath(`/v1/resources/{${name}}`);
            operation.parameters = [parameter(dialect, name, "path")];
        },
    },
    sensitiveQueryString: {
        positive: "query parameter is named name", negative: "query parameter is named password",
        message: "$rule", nativeV2: headerGap,
        prepare: ({ operation, dialect, variant }) => {
            operation.parameters = [parameter(dialect, variant === "positive" ? "name" : "password", "query")];
        },
    },
    allowedMethod: {
        positive: "GET is allowed", negative: "TRACE is disallowed",
        message: "$rule",
        prepare: ({ variant, changeMethod }) => { if (variant === "negative") changeMethod("trace"); },
    },
    sorting: {
        positive: "sort_key precedes sort_dir; asc/desc enum and asc default",
        negative: "sort_dir enum contains sideways",
        message: "enum contains invalid value", nativeV2: { task: "T13", reason: "v2 enum/default are read from param.schema." },
        prepare: ({ operation, dialect, variant }) => {
            operation.parameters = [
                parameter(dialect, "sort_key", "query"),
                parameter(dialect, "sort_dir", "query", {
                    type: "string", enum: variant === "positive" ? ["asc", "desc"] : ["asc", "sideways"], default: "asc",
                }),
            ];
        },
    },
    timestamp: {
        positive: "created_at has an ISO 8601 example", negative: "created_at example is not a date",
        message: 'Found example for "created_at"',
        nativeV2: { task: "T15", reason: "Function dereferences components.schemas instead of native definitions." },
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") object(object(object(definitions.Resource).properties).created_at).example = "not-a-date";
        },
    },
    timeName: {
        positive: "schema uses created_at", negative: "schema uses deprecated create_time",
        message: 'Found "create_time"', nativeV2: bodyGap("T15"),
        prepare: ({ definitions, variant }) => {
            if (variant === "negative") {
                const props = object(object(definitions.Resource).properties);
                props.create_time = props.created_at;
                delete props.created_at;
            }
        },
    },
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof scenarios;

export function scenarioDefinition(name: ScenarioName): Scenario {
    return scenarios[name];
}

export function buildScenario(
    name: ScenarioName, dialect: Dialect, variant: Variant, rule: AutoRule
): JsonObject {
    const scenario = scenarioDefinition(name);
    const spec = readFixture(dialect);
    const initialPath = scenario.detail ? detailPath : collectionPath;
    const initialMethod = scenario.method ?? "get";
    const operation = object(object(object(spec.paths)[initialPath])[initialMethod]);
    spec.paths = { [initialPath]: { [initialMethod]: operation } };
    let currentPath = initialPath;
    let currentMethod: string = initialMethod;
    const response = object(object(operation.responses)[initialMethod === "post" ? "201" : "200"]);
    scenario.prepare({
        spec, dialect, variant, rule, operation, response, definitions: schemas(spec, dialect),
        renamePath: (nextPath) => {
            const paths = object(spec.paths);
            paths[nextPath] = paths[currentPath];
            delete paths[currentPath];
            currentPath = nextPath;
        },
        changeMethod: (nextMethod) => {
            const pathItem = object(object(spec.paths)[currentPath]);
            pathItem[nextMethod] = operation;
            delete pathItem[currentMethod];
            currentMethod = nextMethod;
        },
    });
    return spec;
}
