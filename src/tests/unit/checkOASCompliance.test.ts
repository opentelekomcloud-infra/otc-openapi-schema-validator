import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { checkOASVersion } from "@/functions/checkOASVersion";
import { checkOASSpec } from "@/functions/checkOASSpec";

interface ComplianceRule {
    id: string;
    title: string;
    message: string;
    severity: string;
    call: {
        function: string;
        functionParams: {
            allowedVersions?: string[];
            formats?: Record<string, {
                requiredValues: string[];
                optionalValues: string[];
            }>;
        };
    };
}

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

describe("format-version compliance", () => {
    test.each([
        'swagger: "2.0"',
        "swagger: '2.0'",
        "swagger: 2.0",
        "swagger: 2",
        "openapi: 3.0.0",
        "openapi: 3.0.3",
        'openapi: "3.0.10"',
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
