import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import {
    getImplementedRules,
    loadRuleCatalog,
    parseRuleFile,
} from "@/lib/linter/ruleCatalog";
import { functionsMap } from "@/lib/linter/runLinter";

function makeRule(overrides: Record<string, unknown> = {}) {
    return {
        id: "TEST-01",
        title: "Test rule",
        message: "Test violation",
        option: "Mandatory",
        severity: "high",
        status: "implemented",
        call: { function: "checkVersionConvention", functionParams: {} },
        ...overrides,
    };
}

describe("repository rule catalog integrity", () => {
    test("loads all 24 default files, 68 unique rules and 67 implemented bindings", async () => {
        const root = path.join(process.cwd(), "public/rulesets/default");
        const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml"));
        expect(files).toHaveLength(24);
        const rules = await loadRuleCatalog(
            files.map((file) => path.join(root, file)),
            (file) => fs.readFile(file, "utf8")
        );
        const implemented = getImplementedRules(rules, functionsMap);

        expect(rules).toHaveLength(68);
        expect(new Set(rules.map((rule) => rule.id)).size).toBe(68);
        expect(implemented).toHaveLength(67);
        expect(new Set(implemented.map((rule) => rule.call.function)).size).toBe(46);
        expect(Object.keys(functionsMap)).toHaveLength(46);
        expect(rules.filter((rule) => rule.status === "unsupported").map((rule) => rule.id))
            .toEqual(["SLA-020-01-2507-2507-O"]);
        expect(implemented.map((rule) => rule.id)).not.toContain("SLA-020-01-2507-2507-O");
    });

    test("loads all 21 checklist files and 28 unique manual checks", async () => {
        const root = path.join(process.cwd(), "public/manual-checklist");
        const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml"));
        expect(files).toHaveLength(21);
        const rules = await loadRuleCatalog(
            files.map((file) => path.join(root, file)),
            (file) => fs.readFile(file, "utf8")
        );

        expect(rules).toHaveLength(28);
        expect(new Set(rules.map((rule) => rule.id)).size).toBe(28);
    });
});

describe("strict catalog loading", () => {
    test("includes the filename and parser error instead of skipping malformed YAML", () => {
        expect(() => parseRuleFile("rules:\n  - id: [", "broken.yaml"))
            .toThrow(/Invalid rule file "broken.yaml":/);
    });

    test("rejects an empty YAML file with source context", () => {
        expect(() => parseRuleFile("", "empty.yaml")).toThrow('Invalid rule file "empty.yaml"');
    });

    test.each(["null", "[]", "rules: null", "other: []"])(
        "rejects an invalid catalog root: %s",
        (content) => {
            expect(() => parseRuleFile(content, "invalid.yaml")).toThrow('"rules" array');
        }
    );

    test.each([
        null,
        { ...makeRule(), id: "" },
        { ...makeRule(), id: 42 },
        { ...makeRule(), title: undefined },
        { ...makeRule(), message: undefined },
        { ...makeRule(), option: 42 },
    ])("rejects malformed rule entries: %j", (rule) => {
        expect(() => parseRuleFile(yaml.dump({ rules: [rule] }), "invalid.yaml"))
            .toThrow('Invalid rule file "invalid.yaml"');
    });

    test("rejects duplicate IDs inside a file", () => {
        expect(() => parseRuleFile(yaml.dump({ rules: [makeRule(), makeRule()] }), "duplicate.yaml"))
            .toThrow('Duplicate rule ID "TEST-01"');
    });

    test("rejects duplicate IDs across files", async () => {
        await expect(loadRuleCatalog(
            ["first.yaml", "second.yaml"],
            async () => yaml.dump({ rules: [makeRule()] })
        )).rejects.toThrow('Duplicate rule ID "TEST-01"');
    });

    test("a failed file load rejects the whole catalog, not just that file", async () => {
        await expect(loadRuleCatalog(["good.yaml", "missing.yaml"], async (file) => {
            if (file === "missing.yaml") throw new Error("HTTP 404");
            return yaml.dump({ rules: [makeRule()] });
        })).rejects.toThrow('Unable to load rule file "missing.yaml": HTTP 404');
    });

    test("a malformed file rejects the whole catalog", async () => {
        await expect(loadRuleCatalog(["good.yaml", "broken.yaml"], async (file) =>
            file === "broken.yaml" ? "rules: [" : yaml.dump({ rules: [makeRule()] })
        )).rejects.toThrow('Invalid rule file "broken.yaml"');
    });

    test("an empty file list is not a successful catalog", async () => {
        await expect(loadRuleCatalog([], async () => "")).rejects.toThrow("No rule files found");
    });

    test("preserves input file order independently of async completion order", async () => {
        const rules = await loadRuleCatalog(["first.yaml", "second.yaml"], async (file) => {
            if (file === "first.yaml") await Promise.resolve();
            return yaml.dump({ rules: [makeRule({ id: file })] });
        });
        expect(rules.map((rule) => rule.id)).toEqual(["first.yaml", "second.yaml"]);
    });
});

describe("implemented function bindings", () => {
    test("an explicitly unsupported rule does not require an implemented function", () => {
        expect(getImplementedRules([
            makeRule({ status: "unsupported", call: { function: "notImplemented" } }),
        ], functionsMap)).toEqual([]);
    });

    test("matches implemented status consistently across API and UI", () => {
        expect(getImplementedRules([makeRule({ status: "Implemented" })], functionsMap))
            .toHaveLength(1);
    });

    test.each(["unknownFunction", "toString", "constructor"])(
        "rejects unknown or inherited function %s",
        (name) => {
            expect(() => getImplementedRules([
                makeRule({ call: { function: name } }),
            ], functionsMap)).toThrow(`unknown function "${name}"`);
        }
    );

    test.each([undefined, {}, { function: "" }, { function: 42 }])(
        "rejects missing or invalid call.function: %j",
        (call) => {
            expect(() => getImplementedRules([makeRule({ call })], functionsMap))
                .toThrow("missing call.function");
        }
    );

    test("rejects missing status instead of quietly excluding the rule", () => {
        expect(() => getImplementedRules([makeRule({ status: undefined })], functionsMap))
            .toThrow("missing status");
    });

    test("rejects invalid functionParams", () => {
        expect(() => getImplementedRules([
            makeRule({ call: { function: "checkVersionConvention", functionParams: [] } }),
        ], functionsMap)).toThrow("object call.functionParams");
    });
});
