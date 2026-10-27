/** @jest-environment jsdom */
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Diagnostic } from "@codemirror/lint";
import IssuesPanel, { type IssuesPanelHandle } from "@/components/IssuesPanel";
import RulesetsSelector from "@/components/RulesetsSelector";
import type { AutoRule } from "@/lib/linter/ruleCatalog";

let root: Root;
let container: HTMLDivElement;
beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
});
async function choice(label: string, value: string) {
    const element = container.querySelector<HTMLScaleDropdownSelectElement>(`scale-dropdown-select[label="${label}"]`);
    if (!element) throw new Error(`Missing Scale select ${label}`);
    await act(async () => {
        element.value = value;
        element.dispatchEvent(new CustomEvent("scale-change", { bubbles: true }));
    });
}
async function search(label: string, value: string) {
    const element = container.querySelector<HTMLScaleTextFieldElement>(`scale-text-field[label="${label}"]`);
    if (!element) throw new Error(`Missing Scale search ${label}`);
    await act(async () => {
        element.value = value;
        element.dispatchEvent(new CustomEvent("scale-input", { bubbles: true }));
    });
}
async function click(label: string) {
    const element = [...container.querySelectorAll<HTMLElement>("scale-button,button")]
        .find((button) => button.textContent?.trim() === label);
    if (!element) throw new Error(`Missing button ${label}`);
    await act(async () => element.click());
}
const content = "x\n".repeat(220);
const diagnostics: Diagnostic[] = Array.from({ length: 205 }, (_, index) => ({
    from: index * 2, to: index * 2 + 1,
    severity: index % 2 ? "warning" : "error",
    source: `Rule TEST-00${index % 2 + 1}-M - Example rule`,
    message: `Issue ${index}`,
}));
function panel(extra: Partial<React.ComponentProps<typeof IssuesPanel>> = {}) {
    return React.createElement(IssuesPanel, {
        diagnostics, content, isLinting: false, lintError: null, hasDocument: true,
        rulesSelected: 2, onNavigate: jest.fn(), onConfigureRules: jest.fn(), ...extra,
    });
}

test("issues have bounded pages, non-destructive filters, grouping and keyboard-accessible source navigation", async () => {
    const navigate = jest.fn();
    await act(async () => root.render(panel({ onNavigate: navigate })));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(100);
    expect(container.textContent).toContain("205 of 205 issues");
    await click("Next page");
    expect(container.textContent).toContain("Page 2 of 3");
    await choice("Severity", "high");
    expect(container.textContent).toContain("102 of 205 issues");
    expect(container.textContent).toContain("Page 1 of 2");
    await choice("Group by", "rule");
    expect(container.querySelector(".issueGroupHeading")?.textContent).toContain("TEST-002-M");
    await click("Next issue");
    expect(navigate).toHaveBeenCalledWith(diagnostics[1]);
    expect(container.querySelector("tr[data-active=true]")).not.toBeNull();
    await search("Search issues", "no matching message");
    expect(container.textContent).toContain("No matching issues");
    expect(container.textContent).not.toContain("No lint issues.");
    await click("Clear filters");
    expect(container.textContent).toContain("205 of 205 issues");
    expect(diagnostics).toHaveLength(205);
});

test("revealing an issue from the editor clears filters and opens its exact page without losing focus selection", async () => {
    const ref = createRef<IssuesPanelHandle>();
    await act(async () => root.render(panel({ ref })));
    await choice("Severity", "high");
    await search("Search issues", "not present");
    await act(async () => ref.current?.reveal(diagnostics[204]));
    expect(container.textContent).toContain("Page 3 of 3");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(container.querySelector("tr[data-active=true]")?.textContent).toContain("Issue 204");
});

test("full issue details use Scale modal close events and keep the original message intact", async () => {
    const message = "Long response context ".repeat(100);
    await act(async () => root.render(panel({ diagnostics: [{ ...diagnostics[0], message }] })));
    await click("Details");
    const modal = container.querySelector("scale-modal");
    expect(modal?.getAttribute("heading")).toBe("Issue details");
    expect(modal?.querySelector(".fullMessage")?.textContent).toBe(message);
    await act(async () => modal?.dispatchEvent(new CustomEvent("scale-close")));
    expect(container.querySelector("scale-modal")).toBeNull();
});

test.each([
    { extra: { hasDocument: false, rulesSelected: 0 }, expected: "Start with a specification" },
    { extra: { rulesSelected: 0 }, expected: "Choose rules to validate" },
    { extra: { isLinting: true }, expected: "Validating specification..." },
    { extra: { lintError: "Unable to validate" }, expected: "Unable to validate" },
    { extra: {}, expected: "No lint issues." },
])("distinguishes workspace state: $expected", async ({ extra, expected }) => {
    await act(async () => root.render(panel({ diagnostics: [], ...extra })));
    expect(container.textContent).toContain(expected);
    if (expected !== "No lint issues.") expect(container.textContent).not.toContain("No lint issues.");
});

test("rule severity/search filters never change selection; bulk actions preserve hidden selections", async () => {
    const rules = [
        { id: "TEST-001-M", title: "Critical mandatory", option: "Mandatory", severity: "critical" },
        { id: "TEST-002-M", title: "Low mandatory", option: "Mandatory", severity: "low" },
        { id: "TEST-003-O", title: "Medium optional", option: "Optional", severity: "medium" },
    ].map((rule) => ({ ...rule, message: rule.title, status: "implemented",
        call: { function: "checkOASVersion", functionParams: { allowedVersions: ["2.0", "3.0"] } } }));
    const fetch = jest.fn(async (url: string) => url === "/api/rulesets"
        ? { ok: true, json: async () => ({ default: ["Test"] }) }
        : { ok: true, text: async () => JSON.stringify({ rules }) });
    Object.assign(globalThis, { fetch });
    const selected = jest.fn<void, [AutoRule[]]>();
    await act(async () => root.render(React.createElement(RulesetsSelector, { onSelectionChange: selected })));
    await choice("Ruleset", "default");
    expect(selected.mock.calls.at(-1)?.[0].map((rule) => rule.id)).toEqual(["TEST-001-M", "TEST-002-M"]);
    selected.mockClear();
    await choice("Rule severity", "medium");
    await search("Search rules", "optional");
    expect(selected).not.toHaveBeenCalled();
    expect(container.textContent).toContain("2 selected outside filter");
    await click("Select filtered");
    expect(selected.mock.calls.at(-1)?.[0].map((rule) => rule.id)).toEqual(["TEST-001-M", "TEST-002-M", "TEST-003-O"]);
    await click("Clear filtered");
    expect(selected.mock.calls.at(-1)?.[0].map((rule) => rule.id)).toEqual(["TEST-001-M", "TEST-002-M"]);
    await choice("Rule severity", "all");
    await search("Search rules", "");
    expect(container.querySelectorAll("scale-checkbox")).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(2);
});
