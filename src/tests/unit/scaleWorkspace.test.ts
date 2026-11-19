/** @jest-environment jsdom */
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Diagnostic } from "@codemirror/lint";
import IssuesPanel, { type IssuesPanelHandle } from "@/components/IssuesPanel";
import RulesetsSelector from "@/components/RulesetsSelector";
import ExclusionsImport from "@/components/ExclusionsImport";
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
async function pasteExclusions(value: unknown) {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Import API exclusions JSON"]');
    if (!textarea) throw new Error("Missing exclusions import textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing textarea value setter");
    await act(async () => {
        setter.call(textarea, typeof value === "string" ? value : JSON.stringify(value));
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
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

test("skipped Gitea-only checks never display full success and expose an explicit retry", async () => {
    const retry = jest.fn();
    await act(async () => root.render(panel({
        diagnostics: [], baselineUnavailable: "Baseline could not be loaded.", onRetryBaseline: retry,
    })));
    expect(container.textContent).toContain("Gitea checks skipped (SKIP).");
    expect(container.textContent).toContain("No issues from the completed checks.");
    expect(container.textContent).not.toContain("No lint issues.");
    await click("Retry Gitea connection");
    expect(retry).toHaveBeenCalledTimes(1);
});

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

test.each(["none", "rule", "line"])("page changes focus and reveal the first %s-grouped issue without moving the editor", async (groupBy) => {
    const scrollIntoView = jest.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
        const navigate = jest.fn();
        await act(async () => root.render(panel({ onNavigate: navigate })));
        await choice("Group by", groupBy);
        for (const direction of ["Next page", "Next page", "Previous page"]) {
            await click(direction);
            const firstRow = container.querySelector("tbody tr");
            expect(firstRow?.getAttribute("data-active")).toBe("true");
            expect(document.activeElement).toBe(firstRow?.querySelector("button"));
            expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });
            expect(scrollIntoView.mock.contexts.at(-1)).toBe(firstRow);
            expect(navigate).not.toHaveBeenCalled();
        }
        const secondMessage = container.querySelectorAll(".issuePreview")[1]?.textContent;
        await click("Next issue");
        expect(container.querySelector("tr[data-active=true] .issuePreview")?.textContent).toBe(secondMessage);
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
        if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
        else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
});

test.each(["rule", "line"])("%s grouping spans the full list before pagination and issue navigation", async (groupBy) => {
    const issues: Diagnostic[] = Array.from({ length: 205 }, (_, index) => ({
        from: groupBy === "rule" ? index * 2 : (index % 2) * 2,
        to: groupBy === "rule" ? index * 2 + 1 : (index % 2) * 2 + 1,
        severity: "error",
        source: groupBy === "rule" ? `Rule TEST-00${index % 2 + 1}-M - Example rule`
            : `Rule TEST-${String(index).padStart(3, "0")}-M - Example rule`,
        message: `Issue ${index}`,
    }));
    const navigate = jest.fn();
    await act(async () => root.render(panel({ diagnostics: issues, onNavigate: navigate })));
    await choice("Sort by", groupBy === "rule" ? "line" : "rule");
    await choice("Group by", groupBy);
    const messages = () => [...container.querySelectorAll(".issuePreview")].map((element) => element.textContent);
    const headings = () => [...container.querySelectorAll(".issueGroupHeading")].map((element) => element.textContent);
    const firstGroup = groupBy === "rule" ? "TEST-001-M" : "Line 1";
    const secondGroup = groupBy === "rule" ? "TEST-002-M" : "Line 2";
    expect(messages()).toEqual(issues.filter((_, index) => index % 2 === 0).slice(0, 100).map((issue) => issue.message));
    expect(headings()).toEqual([`${firstGroup} (103 total · 100 on this page)`]);
    const lastRow = container.querySelectorAll<HTMLElement>("tbody tr")[99];
    await act(async () => lastRow.click());
    await click("Next issue");
    expect(navigate).toHaveBeenLastCalledWith(issues[200]);
    expect(container.textContent).toContain("Page 2 of 3");
    expect(container.querySelector("tr[data-active=true] .issuePreview")?.textContent).toBe("Issue 200");
    expect(messages()).toEqual([
        ...[200, 202, 204].map((index) => `Issue ${index}`),
        ...issues.filter((_, index) => index % 2 === 1).slice(0, 97).map((issue) => issue.message),
    ]);
    expect(headings()).toEqual([
        `${firstGroup} (103 total · 3 on this page)`,
        `${secondGroup} (102 total · 97 on this page)`,
    ]);
    await click("Previous issue");
    expect(navigate).toHaveBeenLastCalledWith(issues[198]);
    expect(container.textContent).toContain("Page 1 of 3");
    await click("Next page");
    await click("Next page");
    expect(messages()).toEqual([195, 197, 199, 201, 203].map((index) => `Issue ${index}`));
    expect(headings()).toEqual([`${secondGroup} (102 total · 5 on this page)`]);
    await click("Previous page");
    expect(headings()[0]).toBe(`${firstGroup} (103 total · 3 on this page)`);
    await search("Search issues", "Issue 204");
    expect(messages()).toEqual(["Issue 204"]);
    expect(headings()).toEqual([`${firstGroup} (1 total · 1 on this page)`]);
});

test("copying selected issue ID/message does not navigate or clear selection, but explicit navigation still works", async () => {
    const selection = document.getSelection();
    if (!selection) throw new Error("Missing text selection");
    const navigate = jest.fn(() => selection.removeAllRanges());
    await act(async () => root.render(panel({ diagnostics: [diagnostics[0]], onNavigate: navigate })));
    const row = container.querySelector<HTMLElement>("tbody tr");
    if (!row) throw new Error("Missing issue row");
    await act(async () => row.click());
    expect(row.dataset.active).toBe("true");
    for (const selector of [".ruleId", ".issuePreview"]) {
        const element = row.querySelector(selector);
        if (!element) throw new Error("Missing selectable issue text");
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        await act(async () => row.click());
        expect(selection.toString()).toBe(element.textContent);
        expect(navigate).toHaveBeenCalledTimes(1);
    }
    const line = row.querySelector<HTMLElement>('button[aria-label="Go to line 1"]');
    if (!line) throw new Error("Missing source navigation");
    await act(async () => line.click());
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(selection.isCollapsed).toBe(true);
    await act(async () => row.click());
    expect(navigate).toHaveBeenCalledTimes(3);
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

test("issue URLs are clickable in previews and details without altering text or navigating to source", async () => {
    const url = "https://spec.openapis.org/oas/v3.0.0.html#schemaNullable";
    const otherUrl = "http://example.test/schema?type=string&nullable=true";
    const message = `Received null. See: ${url}. More: ${otherUrl}! javascript:alert(1) <img src=x onerror=alert(1)>`;
    const diagnostic = { ...diagnostics[0], message };
    const navigate = jest.fn();
    await act(async () => root.render(panel({ diagnostics: [diagnostic], onNavigate: navigate })));
    const preview = container.querySelector(".issuePreview");
    expect(preview?.textContent).toBe(message);
    const links = preview?.querySelectorAll<HTMLAnchorElement>("a");
    expect(links).toHaveLength(2);
    for (const [index, href] of [url, otherUrl].entries()) {
        expect(links?.[index].getAttribute("href")).toBe(href);
        expect(links?.[index].getAttribute("target")).toBe("_blank");
        expect(links?.[index].getAttribute("rel")).toBe("noopener noreferrer");
    }
    const link = links?.[0];
    if (!link) throw new Error("Missing documentation link");
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(async () => link.click());
    expect(navigate).not.toHaveBeenCalled();
    await click("Details");
    const details = container.querySelector("scale-modal .fullMessage");
    expect(details?.textContent).toBe(message);
    expect([...details?.querySelectorAll("a") ?? []].map((anchor) => anchor.getAttribute("href"))).toEqual([url, otherUrl]);
    expect(container.querySelector("img, script")).toBeNull();
    await click("Go to source");
    expect(navigate).toHaveBeenCalledWith(diagnostic);
});

test.each([
    { message: "See (https://example.test/foo).", urls: ["https://example.test/foo"] },
    { message: "See [https://example.test/foo] and {https://example.test/bar}.",
        urls: ["https://example.test/foo", "https://example.test/bar"] },
    { message: "See (https://example.test/Foo_(bar(baz))).", urls: ["https://example.test/Foo_(bar(baz))"] },
    { message: "See [http://[::1]].", urls: ["http://[::1]"] },
])("issue links exclude surrounding brackets but preserve balanced URL brackets: $message", async ({ message, urls }) => {
    await act(async () => root.render(panel({ diagnostics: [{ ...diagnostics[0], message }] })));
    await click("Details");
    for (const selector of [".issuePreview", "scale-modal .fullMessage"]) {
        const element = container.querySelector(selector);
        expect(element?.textContent).toBe(message);
        expect(Array.from(element?.querySelectorAll("a") ?? [], (anchor) => anchor.getAttribute("href"))).toEqual(urls);
    }
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
    const loaded = jest.fn<void, [AutoRule[] | null]>();
    await act(async () => root.render(React.createElement(RulesetsSelector, { onSelectionChange: selected, onRulesLoaded: loaded })));
    await choice("Ruleset", "default");
    expect(loaded.mock.calls.at(-1)?.[0]?.map((rule) => rule.id)).toEqual(["TEST-001-M", "TEST-002-M", "TEST-003-O"]);
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
    await choice("Ruleset", "");
    expect(loaded).toHaveBeenLastCalledWith(null);
});

test("API exclusions import switches catalogs, replaces checkboxes including optional rules, and restores normal ruleset selection", async () => {
    const makeRule = (id: string, option: string) => ({
        id, title: id, message: id, option, severity: "medium", status: "implemented",
        call: { function: "checkOASVersion", functionParams: { allowedVersions: ["2.0", "3.0"] } },
    });
    const catalogs = {
        default: [makeRule("DEFAULT-M", "Mandatory")],
        other: [makeRule("OTHER-M", "Mandatory"), makeRule("OTHER-O", "Optional")],
    };
    const fetch = jest.fn(async (url: string) => url === "/api/rulesets"
        ? { ok: true, json: async () => ({ default: ["Test"], other: ["Test"] }) }
        : { ok: true, text: async () => JSON.stringify({ rules: url.includes("/other/") ? catalogs.other : catalogs.default }) });
    Object.assign(globalThis, { fetch });
    const selected = jest.fn<void, [AutoRule[]]>();
    const ruleset = jest.fn();
    const imported = jest.fn();
    await act(async () => root.render(React.createElement(RulesetsSelector, {
        onSelectionChange: selected, onRulesetChange: ruleset, onExclusionsImported: imported,
    })));
    await choice("Ruleset", "default");
    await search("Search rules", "not present");
    await click("Import API exclusions");
    const issues = [{ rule_id: "OTHER-O", line_number: 3 }, { rule_id: "NO-LONGER-EXISTS", line_number: 900 }];
    await pasteExclusions({ ruleset: "other", exclude_auto_rules: ["OTHER-M"], exclude_issues: issues });
    await click("Import exclusions");
    expect(container.querySelector("scale-modal")).toBeNull();
    expect(ruleset).toHaveBeenLastCalledWith("other");
    expect(selected.mock.calls.at(-1)?.[0].map((rule) => rule.id)).toEqual(["OTHER-O"]);
    expect(imported).toHaveBeenLastCalledWith(issues);
    const checkboxes = () => [...container.querySelectorAll<HTMLScaleCheckboxElement>("scale-checkbox")];
    expect(checkboxes().map((checkbox) => [checkbox.getAttribute("label"), checkbox.hasAttribute("checked")])).toEqual([
        ["Select OTHER-M", false], ["Select OTHER-O", true],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);

    await click("Import API exclusions");
    await pasteExclusions({ ruleset: "other", exclude_auto_rules: [], exclude_issues: [] });
    await click("Import exclusions");
    expect(selected.mock.calls.at(-1)?.[0].map((rule) => rule.id)).toEqual(["OTHER-M", "OTHER-O"]);
    expect(imported).toHaveBeenLastCalledWith([]);
    expect(fetch).toHaveBeenCalledTimes(3);
    await choice("Ruleset", "default");
    await choice("Ruleset", "other");
    expect(selected.mock.calls.at(-1)?.[0].map((rule) => rule.id)).toEqual(["OTHER-M"]);
});

test("invalid exclusions, unknown catalogs/rules and failed catalog loads preserve the current rules and mutes", async () => {
    const rules = [{ id: "TEST-M", title: "Test", message: "Test", option: "Mandatory", severity: "high",
        status: "implemented", call: { function: "checkOASVersion" } }];
    Object.assign(globalThis, { fetch: jest.fn(async (url: string) => url === "/api/rulesets"
        ? { ok: true, json: async () => ({ default: ["Test"], broken: ["Test"] }) }
        : url.includes("/broken/") ? { ok: false, status: 503 }
            : { ok: true, text: async () => JSON.stringify({ rules }) }) });
    const selected = jest.fn();
    const ruleset = jest.fn();
    const imported = jest.fn();
    await act(async () => root.render(React.createElement(RulesetsSelector, {
        onSelectionChange: selected, onRulesetChange: ruleset, onExclusionsImported: imported,
    })));
    await choice("Ruleset", "default");
    selected.mockClear();
    ruleset.mockClear();
    await click("Import API exclusions");
    for (const [value, message] of [
        ["{", "Unable to import exclusions"],
        [{ ruleset: "unknown" }, "Unknown ruleset: unknown"],
        [{ ruleset: "default", exclude_auto_rules: ["UNKNOWN"] }, "UNKNOWN"],
        [{ ruleset: "broken" }, "HTTP 503"],
    ] as const) {
        await pasteExclusions(value);
        await click("Import exclusions");
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
        expect(selected).not.toHaveBeenCalled();
        expect(ruleset).not.toHaveBeenCalled();
        expect(imported).not.toHaveBeenCalled();
    }
});

test("JSON files populate the import preview, apply only on confirmation, and surface read failures", async () => {
    const readers: FileReader[] = [];
    jest.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) { readers.push(this); });
    const imported = jest.fn();
    const config = { ruleset: "default", exclude_auto_rules: [], exclude_issues: [] };
    await act(async () => root.render(React.createElement(ExclusionsImport, {
        loadRules: async () => [], onImport: imported,
    })));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Load API exclusions file"]');
    if (!input) throw new Error("Missing exclusions file input");
    const upload = async () => {
        Object.defineProperty(input, "files", { configurable: true, value: [new File([JSON.stringify(config)], "exclusions.json")] });
        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    };
    await upload();
    Object.defineProperty(readers[0], "result", { configurable: true, value: JSON.stringify(config) });
    await act(async () => {
        readers[0].dispatchEvent(new ProgressEvent("load"));
        readers[0].dispatchEvent(new ProgressEvent("loadend"));
    });
    expect(container.querySelector("textarea")?.value).toBe(JSON.stringify(config));
    expect(imported).not.toHaveBeenCalled();
    await click("Import exclusions");
    expect(imported).toHaveBeenCalledWith(config, []);

    await upload();
    await act(async () => {
        readers[1].dispatchEvent(new ProgressEvent("error"));
        readers[1].dispatchEvent(new ProgressEvent("loadend"));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to read the selected JSON file");
    expect(imported).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
});

test("closing the import dialog before its catalog loads cancels all selection changes", async () => {
    let finish: ((rules: AutoRule[]) => void) | undefined;
    const imported = jest.fn();
    const loadRules = jest.fn(() => new Promise<AutoRule[]>((resolve) => { finish = resolve; }));
    await act(async () => root.render(React.createElement(ExclusionsImport, { loadRules, onImport: imported })));
    await pasteExclusions({ ruleset: "other" });
    await click("Import exclusions");
    expect(loadRules).toHaveBeenCalledWith("other");
    await act(async () => root.render(null));
    await act(async () => finish?.([]));
    expect(imported).not.toHaveBeenCalled();
});

test("closing a Scale dialog cancels its pending shadow animations before their targets are removed", async () => {
    await act(async () => root.render(panel()));
    await click("Details");
    const modal = container.querySelector("scale-modal");
    if (!modal) throw new Error("Missing Scale dialog");
    const shadow = modal.attachShadow({ mode: "open" });
    const cancel = jest.fn();
    Object.defineProperty(shadow, "getAnimations", { value: () => [{ cancel }] });
    await act(async () => root.render(null));
    expect(cancel).toHaveBeenCalledTimes(1);
});
