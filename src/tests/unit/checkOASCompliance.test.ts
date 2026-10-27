import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { checkOASVersion } from "@/functions/checkOASVersion";
import { checkOASSpec } from "@/functions/checkOASSpec";
import { classifyNativeOpenApiDocument, parseNativeOpenApi } from "@/lib/openapi/parseNativeOpenApi";
import { NativeOpenApiError } from "@/lib/openapi/documentError";
import { runLinter } from "@/lib/linter/runLinter";
import { sourceLineNumber } from "@/lib/openapi/sourceMap";
import type { ComplianceRule } from "@/utils/compliance";

jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Compliance must not convert documents."); }),
    convertObj: jest.fn(() => { throw new Error("Compliance must not convert documents."); }),
}), { virtual: true });

const catalog = yaml.load(fs.readFileSync(
    path.join(process.cwd(), "public/rulesets/default/OAS_Compliance.yaml"),
    "utf8"
)) as { rules: ComplianceRule[] };

function getRule(functionName: string): ComplianceRule {
    const rule = catalog.rules.find((entry) => entry.call.function === functionName);
    if (!rule) throw new Error(`Missing compliance rule: ${functionName}`);
    return rule;
}

const versionRule = getRule("checkOASVersion");
const structureRule = getRule("checkOASSpec");
const apiVersionCatalog = yaml.load(fs.readFileSync(
    path.join(process.cwd(), "public/rulesets/default/API_version_management.yaml"),
    "utf8"
)) as { rules: ComplianceRule[] };
const apiVersionRules = apiVersionCatalog.rules.filter((rule) => rule.call.function === "checkVersionConvention");

function withParams(rule: ComplianceRule, params: Record<string, unknown>): ComplianceRule {
    return { ...rule, call: { ...rule.call, functionParams: params } };
}

type Format = "yaml" | "json" | "flow-yaml";
const formats: Format[] = ["yaml", "json", "flow-yaml"];

function serialize(spec: unknown, format: Format): string {
    return format === "json" ? JSON.stringify(spec)
        : yaml.dump(spec, { noRefs: true, ...(format === "flow-yaml" ? { flowLevel: 0 } : {}) });
}

describe("format-version compliance", () => {
    test.each([
        'swagger: "2.0"',
        "swagger: '2.0'",
        "swagger: 2.0",
        "swagger: 2",
        "openapi: 3.0.0",
        "openapi: 3.0.3",
        'openapi: "3.0.10"',
        String.raw`openapi: "\u0033.0.3"`,
    ])("accepts %s without conversion", (declaration) => {
        const content = `${declaration}\ninfo:\n  title: Demo\n  version: v1\npaths: {}\n`;
        const spec = yaml.load(content);
        const before = JSON.stringify(spec);

        expect(checkOASVersion(spec, content, versionRule)).toEqual([]);
        expect(checkOASSpec(spec, content, structureRule)).toEqual([]);
        expect(JSON.stringify(spec)).toBe(before);
    });

    test.each([
        'swagger: "2"',
        'swagger: "1.2"',
        'swagger: "2.1"',
        'swagger: "2.0.1"',
        'swagger: "3.0.3"',
        "openapi: 2.0",
        "openapi: 3.1.0",
        "openapi: 4.0.0",
        "openapi: invalid",
        "openapi: 3.0.invalid",
        'openapi: "3.0"',
        "openapi: 3.0",
        "openapi: 3",
        'openapi: "3.0.3 "',
        'openapi: "3.0.3\\n"',
        'swagger: ["2.0"]',
        "openapi: [3.0.3]",
        "openapi: null",
    ])("rejects %s", (declaration) => {
        const content = `${declaration}\ninfo: {version: v2}\npaths: {}\n`;
        const diagnostics = checkOASVersion(yaml.load(content), content, versionRule);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("is not allowed");
        expect(diagnostics[0].severity).toBe("error");
        expect(diagnostics[0].source).toContain(versionRule.id);
        expect(diagnostics[0].from).toBeGreaterThanOrEqual(0);
        expect(diagnostics[0].to).toBeLessThanOrEqual(content.length);
    });

    test("does not infer the format from info.version", () => {
        const content = "info: {title: Demo, version: v2}\npaths: {}\n";
        const diagnostics = checkOASVersion(yaml.load(content), content, versionRule);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("Missing 'swagger' or 'openapi'");
    });

    test("rejects conflicting format declarations", () => {
        const content = 'swagger: "2.0"\nopenapi: 3.0.3\npaths: {}\n';
        const diagnostics = checkOASVersion(yaml.load(content), content, versionRule);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("not both");
    });

    test("honors a ruleset that excludes Swagger 2.0", () => {
        const content = 'swagger: "2.0"\npaths: {}\n';
        const rule = {
            ...versionRule,
            call: { ...versionRule.call, functionParams: { allowedVersions: ["3.0"] } },
        };

        expect(checkOASVersion(yaml.load(content), content, rule)).toHaveLength(1);
    });

    test("accepts native Swagger JSON without changing its version marker", () => {
        const content = '{"swagger":"2.0","info":{"title":"Demo","version":"v1"},"paths":{}}';
        const spec = yaml.load(content) as Record<string, unknown>;

        expect(checkOASVersion(spec, content, versionRule)).toEqual([]);
        expect(checkOASSpec(spec, content, structureRule)).toEqual([]);
        expect(spec.swagger).toBe("2.0");
        expect(spec).not.toHaveProperty("openapi");
    });

    test("highlights the unsupported version in the original content", () => {
        const content = '# Original comment\nswagger: "2.1"\npaths: {}\n';
        const [diagnostic] = checkOASVersion(yaml.load(content), content, versionRule);

        expect(content.slice(diagnostic.from, diagnostic.to)).toBe('"2.1"');
    });
});

describe.each(formats)("native compliance in %s", (format) => {
    test.each([
        { label: "Swagger string", marker: { swagger: "2.0" }, valid: true },
        { label: "Swagger number", marker: { swagger: 2 }, valid: true },
        { label: "OpenAPI string", marker: { openapi: "3.0.3" }, valid: true },
        { label: "OpenAPI patch 10", marker: { openapi: "3.0.10" }, valid: true },
        { label: "short Swagger string", marker: { swagger: "2" }, valid: false },
        { label: "short OpenAPI string", marker: { openapi: "3.0" }, valid: false },
        { label: "numeric OpenAPI", marker: { openapi: 3 }, valid: false },
        { label: "OpenAPI 3.1", marker: { openapi: "3.1.1" }, valid: false },
        { label: "OpenAPI 3.2", marker: { openapi: "3.2.0" }, valid: false },
        { label: "OpenAPI null", marker: { openapi: null }, valid: false },
        { label: "OpenAPI boolean", marker: { openapi: true }, valid: false },
        { label: "OpenAPI array", marker: { openapi: ["3.0.3"] }, valid: false },
        { label: "OpenAPI object", marker: { openapi: { version: "3.0.3" } }, valid: false },
        { label: "conflicting markers", marker: { swagger: "2.0", openapi: "3.0.3" }, valid: false },
        { label: "conflict with null", marker: { swagger: null, openapi: "3.0.3" }, valid: false },
        { label: "missing marker", marker: {}, valid: false },
    ])("$label agrees with the native classifier and preserves its input", ({ marker, valid }) => {
        const spec = Object.freeze({
            ...marker, info: Object.freeze({ title: "Native", version: "v9" }), paths: Object.freeze({}),
        });
        const before = JSON.stringify(spec);
        const content = serialize(spec, format);
        for (const [check, rule] of [[checkOASVersion, versionRule], [checkOASSpec, structureRule]] as const) {
            const diagnostics = check(spec, content, rule);
            expect(diagnostics).toHaveLength(valid ? 0 : 1);
            for (const diagnostic of diagnostics) {
                expect(diagnostic.source).toContain(rule.id);
                expect(diagnostic.severity).toBe("error");
                expect(diagnostic.from).toBeGreaterThanOrEqual(0);
                expect(diagnostic.to).toBeLessThanOrEqual(content.length);
            }
        }
        if (valid) {
            expect(classifyNativeOpenApiDocument(spec).document).toBe(spec);
            const context = parseNativeOpenApi(content, { format: format === "json" ? "json" : "yaml" });
            const nativeBefore = JSON.stringify(context.document);
            expect(checkOASVersion(context.document, context.originalContent, versionRule)).toEqual([]);
            expect(checkOASSpec(context.document, context.originalContent, structureRule)).toEqual([]);
            expect(context.originalContent).toBe(content);
            expect(JSON.stringify(context.document)).toBe(nativeBefore);
        } else {
            expect(() => classifyNativeOpenApiDocument(spec)).toThrow(NativeOpenApiError);
        }
        expect(JSON.stringify(spec)).toBe(before);
    });

    test.each([{ swagger: "2.0" }, { openapi: "3.0.3" }])(
        "allows only opted-in root extensions for %j",
        (marker) => {
            const spec = {
                ...marker, info: {}, paths: {},
                "x-service": { components: {}, swagger: "literal extension data" },
                "x-empty": null, "x-enabled": true, "x-values": [1, "value"],
            };
            const content = serialize(spec, format);
            const params = { ...structureRule.call.functionParams };
            delete params.allowExtensions;
            expect(checkOASSpec(spec, content, structureRule)).toEqual([]);
            for (const rule of [
                withParams(structureRule, params),
                withParams(structureRule, { ...params, allowExtensions: false }),
            ]) {
                const diagnostics = checkOASSpec(spec, content, rule);
                expect(diagnostics).toHaveLength(4);
                for (const diagnostic of diagnostics) {
                    expect(diagnostic.message).toContain("Disallowed top-level field: 'x-");
                }
            }
            for (const field of ["X-service", "x_service", "unexpected",
                "swagger" in marker ? "components" : "definitions"]) {
                const invalid = { ...spec, [field]: {} };
                const text = serialize(invalid, format);
                const [diagnostic, ...rest] = checkOASSpec(invalid, text, structureRule);
                expect(rest).toEqual([]);
                expect(diagnostic.message).toContain(`Disallowed top-level field: '${field}'`);
                expect(text.slice(diagnostic.from, diagnostic.to))
                    .toBe(format === "json" ? JSON.stringify(field) : field);
            }
        }
    );

    test.each([
        { spec: { swagger: "2.1", info: {}, paths: {} }, marker: "2.1" },
        { spec: { openapi: "3.0", info: {}, paths: {} }, marker: "3.0" },
    ])("retains the authored unsupported marker range in $spec", ({ spec, marker }) => {
        const content = serialize(spec, format);
        const token = format === "json" ? JSON.stringify(marker)
            : yaml.dump(marker).trim();
        for (const [check, rule] of [[checkOASVersion, versionRule], [checkOASSpec, structureRule]] as const) {
            const [diagnostic] = check(spec, content, rule);
            expect(content.slice(diagnostic.from, diagnostic.to)).toBe(token);
            expect(diagnostic.source).toContain(rule.id);
        }
    });
});

describe("malformed roots, own fields and custom compliance configuration", () => {
    test.each(["null", "[]", "42", "true", '"text"'])(
        "rejects non-object root %j without throwing",
        (content) => {
            for (const [check, rule] of [[checkOASVersion, versionRule], [checkOASSpec, structureRule]] as const) {
                const diagnostics = check(yaml.load(content), content, rule);
                expect(diagnostics).toHaveLength(1);
                expect(diagnostics[0].message).toContain("root must be an object");
                expect(diagnostics[0].source).toContain(rule.id);
            }
        }
    );

    test("rejects an absent semantic document without throwing", () => {
        for (const [check, rule] of [[checkOASVersion, versionRule], [checkOASSpec, structureRule]] as const) {
            const diagnostics = check(undefined, "", rule);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("root must be an object");
            expect(diagnostics[0]).toMatchObject({ from: 0, to: 0 });
        }
    });

    test("accepts native null-prototype roots but rejects inherited markers", () => {
        const spec: Record<string, unknown> = Object.create(null);
        Object.assign(spec, { swagger: "2.0", info: {}, paths: {} });
        const content = serialize(spec, "json");
        for (const [check, rule] of [[checkOASVersion, versionRule], [checkOASSpec, structureRule]] as const) {
            expect(check(spec, content, rule)).toEqual([]);
            const [diagnostic] = check(Object.create(spec), content, rule);
            expect(diagnostic.message).toContain("root must be an object");
        }
        expect(Object.getPrototypeOf(spec)).toBeNull();
    });

    test("own conflicting markers are not ignored even when their value is undefined", () => {
        const spec = { swagger: undefined, openapi: "3.0.3", info: {}, paths: {} };
        const content = "swagger:\nopenapi: 3.0.3\ninfo: {}\npaths: {}\n";
        for (const [check, rule] of [[checkOASVersion, versionRule], [checkOASSpec, structureRule]] as const) {
            const diagnostics = check(spec, content, rule);
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0].message).toContain("not both");
        }
    });

    test("does not let Object.prototype satisfy required flat-config fields", () => {
        const rule = withParams(structureRule, { requiredValues: ["toString"], optionalValues: [] });
        const [diagnostic] = checkOASSpec({}, "{}", rule);
        expect(diagnostic.message).toContain("Missing required top-level field: 'toString'");
    });

    test("flat custom config keeps its own lists without introducing a dialect requirement", () => {
        const params = { requiredValues: ["info"], optionalValues: [] };
        const spec = { info: {} };
        const content = "info: {}\n";
        expect(checkOASSpec(spec, content, withParams(structureRule, params))).toEqual([]);
        expect(checkOASSpec(spec, content, structureRule)[0].message).toContain("Missing 'swagger' or 'openapi'");
        const extended = { ...spec, "x-service": null };
        const text = serialize(extended, "json");
        expect(checkOASSpec(extended, text, withParams(structureRule, params))).toHaveLength(1);
        expect(checkOASSpec(extended, text, withParams(structureRule, { ...params, allowExtensions: true }))).toEqual([]);
    });

    test("flat custom allowlists may name specific extensions without opting in to all x-*", () => {
        const rule = withParams(structureRule, {
            requiredValues: ["swagger", "info", "paths"], optionalValues: ["x-service"],
        });
        const spec = { swagger: "2.0", info: {}, paths: {}, "x-service": null };
        expect(checkOASSpec(spec, serialize(spec, "json"), rule)).toEqual([]);
    });

    test.each([
        { params: { allowedVersions: "3.0" }, name: "allowedVersions" },
        { params: { allowedVersions: [3] }, name: "allowedVersions" },
    ])("does not treat malformed $name as a valid version configuration", ({ params, name }) => {
        expect(() => checkOASVersion({ openapi: "3.0.3" }, "openapi: 3.0.3",
            withParams(versionRule, params))).toThrow(`functionParams.${name}`);
    });

    test.each([
        { params: { allowExtensions: "true" }, name: "allowExtensions" },
        { params: { formats: null }, name: "formats" },
        { params: { formats: [] }, name: "formats" },
        { params: { formats: { openapi: {} } }, name: "formats.swagger" },
        { params: { requiredValues: "swagger" }, name: "requiredValues" },
        { params: { optionalValues: [1] }, name: "optionalValues" },
    ])("does not silently fall back for malformed $name configuration", ({ params, name }) => {
        const spec = { swagger: "2.0", info: {}, paths: {} };
        expect(() => checkOASSpec(spec, serialize(spec, "json"),
            withParams(structureRule, params))).toThrow(`functionParams.${name}`);
    });

    test("can exclude either supported dialect without changing the root template", () => {
        for (const [marker, allowedVersions] of [
            [{ swagger: "2.0" }, ["3.0"]],
            [{ openapi: "3.0.3" }, ["2.0"]],
        ] as const) {
            const spec = { ...marker, info: {}, paths: {} };
            const content = serialize(spec, "json");
            expect(checkOASVersion(spec, content, withParams(versionRule, { allowedVersions }))).toHaveLength(1);
            expect(checkOASSpec(spec, content, structureRule)).toEqual([]);
        }
    });

    test("custom allowedVersions cannot enable a dialect unsupported by the native classifier", () => {
        const spec = { openapi: "3.1.1", info: {}, paths: {} };
        const rule = withParams(versionRule, { allowedVersions: ["3.1"] });
        const diagnostics = checkOASVersion(spec, serialize(spec, "json"), rule);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("is not allowed");
    });
});

describe("native compliance through the current engine", () => {
    beforeEach(() => {
        jest.spyOn(console, "debug").mockImplementation(() => undefined);
        jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Compliance must not access the network."));
    });

    afterEach(() => {
        const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
        expect(converter.convertStr).not.toHaveBeenCalled();
        expect(converter.convertObj).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        jest.restoreAllMocks();
    });

    test.each(formats)("both native dialects work without conversion in %s", async (format) => {
        for (const marker of [{ swagger: "2.0" }, { openapi: "3.0.3" }]) {
            const spec = { ...marker, info: { title: "Native", version: "v9" }, paths: {}, "x-service": null };
            const content = serialize(spec, format);
            const result = await runLinter(content, [versionRule, structureRule]);
            expect(result).toEqual({ diagnostics: [], specTitle: "Native" });
        }
    });

    test.each(formats)("all four real API-version bindings remain independent of the format in %s", async (format) => {
        expect(apiVersionRules.map((rule) => rule.id)).toEqual(
            [1, 2, 3, 4].map((number) => `VER-030-01-2507-2507-O-${number}`)
        );
        const invalidVersions: Record<string, string> = {
            presenceAndPrefix: "1", formatCompliance: "vNext",
            maxSegments: "v1.2.3.4.5", normalization: "v1.2",
        };
        for (const marker of [{ swagger: "2.0" }, { openapi: "3.0.3" }]) {
            const spec = { ...marker, info: { title: "Native", version: "v9" }, paths: {} };
            const positive = await runLinter(serialize(spec, format), [versionRule, structureRule, ...apiVersionRules]);
            expect(positive.diagnostics).toEqual([]);
            for (const rule of apiVersionRules) {
                const mode = rule.call.functionParams?.mode;
                if (typeof mode !== "string" || !Object.hasOwn(invalidVersions, mode)) {
                    throw new Error(`Unexpected API-version mode for ${rule.id}`);
                }
                const value = invalidVersions[mode];
                const invalid = { ...spec, info: { ...spec.info, version: value } };
                const content = serialize(invalid, format);
                const { diagnostics } = await runLinter(content, [versionRule, structureRule, rule]);
                expect(diagnostics).toHaveLength(1);
                const [diagnostic] = diagnostics;
                expect(diagnostic.source).toContain(rule.id);
                expect(content.slice(diagnostic.from, diagnostic.to))
                    .toBe(format === "json" ? JSON.stringify(value) : yaml.dump(value).trim());
            }
        }
    });

    test.each(["null", "42", "[]", "openapi: 3.0\ninfo: {}\npaths: {}\n"])(
        "invalid native root %j is a failure of each affected rule, not an execution error",
        async (content) => {
            const { diagnostics } = await runLinter(content, [versionRule, structureRule]);
            expect(diagnostics).toHaveLength(2);
            expect(diagnostics.map((diagnostic) => diagnostic.source))
                .toEqual([expect.stringContaining(versionRule.id), expect.stringContaining(structureRule.id)]);
            for (const diagnostic of diagnostics) {
                expect(diagnostic.message).not.toContain("execution failed");
                expect(diagnostic.lineNumber).toBe(sourceLineNumber(content, diagnostic.from));
            }
        }
    );

    test("malformed configuration retains the affected rule ID as an explicit execution failure", async () => {
        const rule = withParams(structureRule, { formats: {} });
        const content = 'swagger: "2.0"\ninfo: {}\npaths: {}\n';
        const { diagnostics } = await runLinter(content, [rule]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
            source: expect.stringContaining(rule.id),
            message: expect.stringContaining("execution failed: Compliance functionParams.formats.swagger"),
        });
    });
});

describe("top-level structure compliance", () => {
    test("accepts all standard Swagger 2.0 top-level fields", () => {
        const content = yaml.dump({
            swagger: "2.0",
            info: { title: "Demo", version: "v1" },
            paths: {},
            host: "api.example.com",
            basePath: "/v1",
            schemes: ["https"],
            consumes: ["application/json"],
            produces: ["application/json"],
            definitions: {},
            parameters: {},
            responses: {},
            securityDefinitions: {},
            security: [],
            tags: [],
            externalDocs: { url: "https://example.com/docs" },
        });

        expect(checkOASSpec(yaml.load(content), content, structureRule)).toEqual([]);
    });

    test.each(['swagger: "2.0"', "openapi: 3.0.3"])(
        "still requires info and paths for %s",
        (declaration) => {
            const diagnostics = checkOASSpec(yaml.load(declaration), declaration, structureRule);

            expect(diagnostics).toHaveLength(2);
            expect(diagnostics[0].message).toContain("'info'");
            expect(diagnostics[1].message).toContain("'paths'");
        }
    );

    test.each([
        ['swagger: "2.0"', "components"],
        ["openapi: 3.0.3", "definitions"],
        ["openapi: 3.0.3", "unexpected"],
    ])("does not allow mixed or unknown top-level fields: %s / %s", (declaration, field) => {
        const content = `${declaration}\ninfo: {}\npaths: {}\n${field}: {}\n`;
        const diagnostics = checkOASSpec(yaml.load(content), content, structureRule);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain(`Disallowed top-level field: '${field}'`);
    });

    test("preserves legacy flat functionParams in custom rulesets", () => {
        const content = "openapi: 3.0.3\ninfo: {}\npaths: {}\n";
        const rule = {
            ...structureRule,
            call: {
                ...structureRule.call,
                functionParams: {
                    requiredValues: ["openapi", "info", "paths"],
                    optionalValues: [],
                },
            },
        };

        expect(checkOASSpec(yaml.load(content), content, rule)).toEqual([]);
    });
});
