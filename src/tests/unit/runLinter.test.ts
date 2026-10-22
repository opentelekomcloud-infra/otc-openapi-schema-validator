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
});
