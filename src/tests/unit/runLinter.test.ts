import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { buildRobotXml } from "@/lib/export/buildRobotXml";

const content = "openapi: 3.0.3\ninfo: {title: Demo, version: v1}\npaths: {}\n";
const baseRule = {
    id: "TEST-01",
    title: "Configured rule",
    message: "Version must be allowed.",
    severity: "critical",
    call: {
        function: "checkOASVersion",
        functionParams: { allowedVersions: ["3.0"] },
    },
};

describe("rule execution errors", () => {
    beforeEach(() => {
        jest.spyOn(console, "debug").mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    test.each(["unknownFunction", "toString", "constructor"])(
        "reports unknown binding %s instead of silently dropping the rule",
        async (name) => {
            const rule = { ...baseRule, call: { function: name } };
            const { diagnostics, specTitle } = await runLinter(content, [baseRule, rule]);

            expect(specTitle).toBe("Demo");
            expect(diagnostics).toHaveLength(1);
            expect(diagnostics[0]).toMatchObject({
                from: 0,
                to: content.length,
                severity: "error",
                source: `Rule ${rule.id} - ${rule.title}`,
            });
            expect(diagnostics[0].message).toContain(`unknown function "${name}"`);
        }
    );

    test("reports a missing call.function", async () => {
        const { diagnostics } = await runLinter(content, [{ ...baseRule, call: {} }]);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("missing call.function");
        expect(diagnostics[0].source).toContain(baseRule.id);
    });

    test("keeps the rule ID on execution failures so exports do not report it as passed", async () => {
        jest.spyOn(functionsMap, "checkOASVersion").mockImplementation(() => {
            throw new Error("Failed to execute");
        });
        const { diagnostics } = await runLinter(content, [baseRule]);
        const xml = buildRobotXml(diagnostics, { [baseRule.id]: baseRule }, [], content);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].message).toContain("Failed to execute");
        expect(diagnostics[0].source).toContain(baseRule.id);
        const tests = [...xml.matchAll(/<test\b[\s\S]*?<\/test>/g)];
        expect(tests).toHaveLength(1);
        expect(tests[0][0]).toContain('status="FAIL"');
        expect(tests[0][0]).not.toContain('status="PASS"');
    });

    test.each(["openapi: 3.0.3\npaths: [", "openapi: 3.0.3\npaths: [}\n"])("parser errors retain exact original offsets: %j", async (text) => {
        const { diagnostics } = await runLinter(text, [baseRule]);
        const from = text.includes("}") ? text.indexOf("}") : text.length;
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ source: "parser", from, to: Math.min(text.length, from + 1), lineNumber: 2 });
    });

    test("invalid rule offsets are explicit rule failures, not silently clamped successes", async () => {
        jest.spyOn(functionsMap, "checkOASVersion").mockReturnValue([{
            from: -1, to: content.length + 1, severity: "warning", message: "Invalid range",
        }]);
        const { diagnostics } = await runLinter(content, [baseRule]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
            source: `Rule ${baseRule.id} - ${baseRule.title}`, severity: "error", lineNumber: 1,
            message: expect.stringContaining("outside the original content"),
        });
    });

    test("preserves successful validation and parser diagnostics", async () => {
        await expect(runLinter(content, [baseRule])).resolves.toEqual({
            diagnostics: [],
            specTitle: "Demo",
        });
        const { diagnostics } = await runLinter("paths: [", [baseRule]);
        expect(diagnostics).toEqual([
            expect.objectContaining({ source: "parser", severity: "error" }),
        ]);
    });

    test("Robot marks selected rules SKIP, not PASS, when syntax prevented their execution", async () => {
        const execute = jest.spyOn(functionsMap, "checkOASVersion");
        const { diagnostics } = await runLinter("paths: [", [baseRule]);
        expect(execute).not.toHaveBeenCalled();
        const xml = buildRobotXml(diagnostics, { [baseRule.id]: baseRule }, [], "paths: [");
        const ruleCase = [...xml.matchAll(/<test\b[\s\S]*?<\/test>/g)].find(([text]) => text.includes(baseRule.id))?.[0];
        expect(ruleCase).toContain('status="SKIP"');
        expect(ruleCase).not.toContain('status="PASS"');
        expect(xml).toContain('name="Specification parsing"');
        expect(xml).toContain('name="Not Executed Rules"');
    });

    test("parser text mentioning a rule ID cannot incorrectly attribute the document failure to that rule", () => {
        const xml = buildRobotXml([{
            from: 0, to: 0, severity: "error", source: "parser", message: `Invalid syntax near ${baseRule.id}`,
        }], { [baseRule.id]: baseRule }, [], "");
        const ruleCases = [...xml.matchAll(/<test\b[\s\S]*?<\/test>/g)].filter(([text]) => text.includes(`name="Rule ${baseRule.id}`));
        expect(ruleCases).toHaveLength(1);
        expect(ruleCases[0][0]).toContain('status="SKIP"');
    });
});
