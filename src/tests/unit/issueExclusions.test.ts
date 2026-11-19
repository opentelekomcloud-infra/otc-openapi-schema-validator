import type { Diagnostic } from "@codemirror/lint";
import { isIssueExcluded, issueExclusionFor, parseApiExclusions, validateExclusionRuleIds } from "@/lib/linter/issueExclusions";

const source = "openapi: 3.0.3\r\npaths:\r\n  /items: {}\r\n";
const diagnostic: Diagnostic = {
    from: source.indexOf("/items"), to: source.indexOf("/items") + 6,
    source: "Rule QUE-060-01-2507-2507-M - Time fields", message: "Missing updated_at", severity: "warning",
};

test("UI mute selectors match API rule IDs and 1-based authored lines, not message text or other rules", () => {
    const selector = { rule_id: "QUE-060-01-2507-2507-M", line_number: 3 };
    expect(issueExclusionFor(source, diagnostic)).toEqual(selector);
    expect(isIssueExcluded(source, { ...diagnostic, message: "Another missing field" }, [selector])).toBe(true);
    expect(isIssueExcluded(source, { ...diagnostic, from: 0 }, [selector])).toBe(false);
    expect(isIssueExcluded(source, { ...diagnostic, source: "Rule QUE-040-01-2507-2507-M" }, [selector])).toBe(false);
});

test.each(["parser", "version", "unattributed"])("document errors and unidentifiable diagnostics cannot be muted: %s", (sourceName) => {
    expect(issueExclusionFor(source, { ...diagnostic, severity: "error", source: sourceName })).toBeUndefined();
});

test("API exclusions import normalizes and deduplicates the exported format", () => {
    expect(parseApiExclusions(JSON.stringify({
        ruleset: " default ", exclude_auto_rules: [" RULE-1 ", "RULE-1"],
        exclude_issues: [
            { rule_id: " RULE-2 ", line_number: 3 }, { rule_id: "RULE-2", line_number: 3 },
            { rule_id: "RULE-2", line_number: 4 },
        ],
    }))).toEqual({
        ruleset: "default", exclude_auto_rules: ["RULE-1"],
        exclude_issues: [{ rule_id: "RULE-2", line_number: 3 }, { rule_id: "RULE-2", line_number: 4 }],
    });
    expect(parseApiExclusions('{"ruleset":"default"}')).toEqual({
        ruleset: "default", exclude_auto_rules: [], exclude_issues: [],
    });
});

test.each([
    "{", "null", "[]", "{}", '{"ruleset":""}', '{"ruleset":"default","exclude_rules":[]}',
    '{"ruleset":"default","exclude_auto_rules":null}', '{"ruleset":"default","exclude_auto_rules":"RULE-1"}',
    '{"ruleset":"default","exclude_auto_rules":[42]}', '{"ruleset":"default","exclude_auto_rules":[" "]}',
    '{"ruleset":"default","exclude_issues":null}', '{"ruleset":"default","exclude_issues":{}}',
    ...[0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1].map((line_number) => JSON.stringify({
        ruleset: "default", exclude_issues: [{ rule_id: "RULE-1", line_number }],
    })),
    '{"ruleset":"default","exclude_issues":[{"rule_id":"","line_number":1}]}',
    '{"ruleset":"default","exclude_issues":[{"rule_id":"RULE-1","line":1}]}',
])("invalid import JSON is rejected rather than silently replacing exclusions: %s", (json) => {
    expect(() => parseApiExclusions(json)).toThrow();
});

test("unknown excluded automatic rules fail validation, but unmatched issue IDs may be skipped", () => {
    const config = parseApiExclusions(JSON.stringify({
        ruleset: "default", exclude_auto_rules: ["RULE-1"],
        exclude_issues: [{ rule_id: "OLD-RULE", line_number: 200 }],
    }));
    expect(() => validateExclusionRuleIds(config, [{ id: "RULE-1" }])).not.toThrow();
    expect(() => validateExclusionRuleIds(config, [])).toThrow('Unknown automatic rule IDs in ruleset "default": RULE-1');
});
