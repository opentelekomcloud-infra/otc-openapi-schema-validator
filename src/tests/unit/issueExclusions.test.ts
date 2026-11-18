import type { Diagnostic } from "@codemirror/lint";
import { isIssueExcluded, issueExclusionFor } from "@/lib/linter/issueExclusions";

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
