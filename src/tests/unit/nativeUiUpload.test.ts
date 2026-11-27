/** @jest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs/promises";
import path from "node:path";
import * as yamlParser from "js-yaml";
import { EditorView } from "@codemirror/view";
import { foldedRanges, foldEffect } from "@codemirror/language";
import { diagnosticCount, forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import HomePage from "@/app/page";
import { openApiLinter } from "@/components/Linter";
import { functionsMap } from "@/lib/linter/runLinter";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { setAllowedAbbreviations } from "@/utils/englishWords";
import { parseAllowedAbbreviations } from "@/lib/abbreviations";
import { exportRobotFramework, exportPDF, exportReportPortal } from "@/utils/export";
import { coverageLedger } from "@/tests/fixtures/dual-version/coverageLedger";
import { flowExampleContent, readFixtureContent, type Dialect } from "@/tests/fixtures/dual-version/scenarios";
import { parseApiExclusions, type ApiExclusions, type IssueExclusion, type RuleExclusion } from "@/lib/linter/issueExclusions";
import type { ManualRule } from "@/lib/linter/manualCatalog";
import { checkGiteaAvailability } from "@/lib/openapi/baseline";

type LintResult = Awaited<ReturnType<ReturnType<typeof openApiLinter>>>;
let mockSelector: {
    onSelectionChange: (rules: AutoRule[]) => void;
    onRulesLoaded: (rules: AutoRule[] | null) => void;
    onRulesetChange: (name: string) => void;
    onExclusionsImported: (issues: IssueExclusion[]) => void;
    onRuleExclusionsImported: (exclusions: ApiExclusions) => void;
};
let mockManualSelector: {
    onManualRulesChange: (rules: ManualRule[]) => void;
    excludedRules: RuleExclusion[];
    onExcludedRulesChange: (rules: RuleExclusion[]) => void;
};
jest.mock("@telekom/scale-components/dist/scale-components/scale-components.css", () => ({}));
jest.mock("@telekom/scale-components/loader", () => ({
    applyPolyfills: jest.fn(async () => undefined), defineCustomElements: jest.fn(),
}));
jest.mock("@/components/AuthButtons", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ManualChecksSelector", () => ({
    __esModule: true, default: (props: typeof mockManualSelector) => { mockManualSelector = props; return null; },
}));
jest.mock("@/components/RulesetsSelector", () => ({
    __esModule: true, default: (props: typeof mockSelector) => { mockSelector = props; return null; },
}));
jest.mock("@/utils/export", () => ({
    exportRobotFramework: jest.fn(), exportPDF: jest.fn(), exportReportPortal: jest.fn(async () => undefined),
}));
jest.mock("@/components/Linter", () => ({ openApiLinter: jest.fn() }));
jest.mock("@/utils/utils", () => ({ fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn() }));
jest.mock("@/lib/openapi/baseline", () => ({
    ...jest.requireActual<typeof import("@/lib/openapi/baseline")>("@/lib/openapi/baseline"),
    checkGiteaAvailability: jest.fn(async () => undefined),
}));
jest.mock("@/utils/englishWords", () => ({
    ...jest.requireActual<typeof import("@/utils/englishWords")>("@/utils/englishWords"),
    loadAllowedAbbreviationsFromApi: jest.fn(async () => undefined),
}));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("UI must not convert specifications"); }),
    convertObj: jest.fn(() => { throw new Error("UI must not convert specifications"); }),
}), { virtual: true });

let root: Root;
let container: HTMLDivElement;
let rules: AutoRule[];
let savedBlob: Blob | undefined;
const lint = jest.mocked(openApiLinter);

function editor(): EditorView {
    const element = container.querySelector<HTMLElement>(".cm-editor");
    const view = element && EditorView.findFromDOM(element);
    if (!view) throw new Error("Expected the real CodeMirror editor");
    return view;
}
function fileInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) throw new Error("Missing file input");
    return input;
}
function button(text: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>("scale-button,button")]
        .find((element) => element.textContent?.trim() === text || element.getAttribute("aria-label") === text);
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
}
async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    throw new Error("UI did not reach the expected state");
}
async function select(selected: AutoRule[]) {
    await act(async () => mockSelector.onSelectionChange(selected));
    await waitFor(() => !container.textContent?.includes("Validating specification..."));
}
async function upload(content: string, name = "native.yaml") {
    const input = fileInput();
    Object.defineProperty(input, "files", { configurable: true, value: [new File([content], name)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function loaded(content: string) {
    await waitFor(() => editor().state.doc.toString() === content.replace(/\r\n/g, "\n") &&
        !container.textContent?.includes("Validating specification..."));
}
function referenceContent(dialect: Dialect, format: "yaml" | "flow" | "json") {
    const reference = dialect === "swagger2" ? "#/parameters/UserIdInQuery" : "#/components/parameters/UserIdInQuery";
    const parameter = { name: "user_id", in: "query", ...(dialect === "swagger2"
        ? { type: "string" } : { schema: { type: "string" } }) };
    const spec = {
        ...(dialect === "swagger2" ? { swagger: "2.0" } : { openapi: "3.0.3" }),
        info: { title: "Reference navigation", version: "v1" },
        paths: { "/users": { get: { parameters: [{ $ref: reference }], responses: { "200": { description: "OK" } } } } },
        ...(dialect === "swagger2" ? { parameters: { UserIdInQuery: parameter } }
            : { components: { parameters: { UserIdInQuery: parameter } } }),
    };
    return format === "json" ? JSON.stringify(spec, null, 2)
        : yamlParser.dump(spec, { noRefs: true, ...(format === "flow" ? { flowLevel: 0 } : {}) });
}
async function followReference(modifier: "ctrlKey" | "metaKey" = "ctrlKey") {
    const link = editor().dom.querySelector<HTMLElement>(".cm-openapi-ref");
    if (!link) throw new Error("Missing editor reference link");
    for (const type of ["mousedown", "click"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, [modifier]: true });
        await act(async () => { link.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
    }
}
function finding(message: string): Diagnostic {
    return { from: 0, to: 1, severity: "error", source: "UI regression", message };
}
async function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Not text"));
        reader.onerror = () => reject(new Error("Unable to read saved file"));
        reader.readAsText(blob);
    });
}
function controlledReaders(): FileReader[] {
    const readers: FileReader[] = [];
    jest.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) {
        readers.push(this);
    });
    jest.spyOn(FileReader.prototype, "abort").mockImplementation(() => undefined);
    return readers;
}
async function finishRead(reader: FileReader, content: string | ArrayBuffer | null) {
    Object.defineProperty(reader, "result", { configurable: true, value: content });
    await act(async () => {
        reader.dispatchEvent(new ProgressEvent("load"));
        reader.dispatchEvent(new ProgressEvent("loadend"));
    });
}

beforeAll(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: jest.fn(() => ({
        matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn(),
    })) });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: jest.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: jest.fn(async () => undefined) } });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true,
        value: jest.fn((blob: Blob) => { savedBlob = blob; return "blob:ui-test"; }) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: jest.fn() });
    const directory = path.join(process.cwd(), "public/rulesets/default");
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".yaml")).map((file) => path.join(directory, file));
    rules = getImplementedRules(await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8")), functionsMap);
    setAllowedAbbreviations(parseAllowedAbbreviations(
        await fs.readFile(path.join(process.cwd(), "public/lib/allowed_abbreviations.txt"), "utf8")));
});

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(checkGiteaAvailability).mockResolvedValue(undefined);
    savedBlob = undefined;
    Object.assign(globalThis, { fetch: jest.fn(async () => { throw new Error("Unexpected UI network request"); }) });
    jest.spyOn(window, "alert").mockImplementation(() => undefined);
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    lint.mockImplementation(() => async () => ({ diagnostics: [] }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(HomePage)));
    await waitFor(() => Boolean(container.querySelector(".cm-editor")) &&
        !container.textContent?.includes("Validating specification..."));
    await act(async () => {
        mockSelector.onRulesLoaded(rules);
        mockSelector.onRulesetChange("default");
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

async function restartWithProbe(probe: (signal: AbortSignal) => Promise<void>, strict = false) {
    await act(async () => root.unmount());
    jest.mocked(checkGiteaAvailability).mockImplementation(probe);
    root = createRoot(container);
    await act(async () => root.render(strict
        ? React.createElement(React.StrictMode, null, React.createElement(HomePage))
        : React.createElement(HomePage)));
    await waitFor(() => Boolean(container.querySelector(".cm-editor")));
    await act(async () => {
        mockSelector.onRulesLoaded(rules);
        mockSelector.onRulesetChange("default");
    });
}

test("Strict Mode starts only one live availability request", async () => {
    jest.mocked(checkGiteaAvailability).mockClear();
    await restartWithProbe(async () => undefined, true);
    await waitFor(() => !container.textContent?.includes("Checking Gitea connection."));
    expect(checkGiteaAvailability).toHaveBeenCalledTimes(1);
});

test("startup checks do not delay local results and successful probes automatically revalidate without losing mutes", async () => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    let finish: () => void = () => { throw new Error("Probe has not started"); };
    const probe = new Promise<void>((resolve) => { finish = resolve; });
    await restartWithProbe(() => probe);
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "local-test" });
    const source = "openapi: 3.0.3\ninfo: {title: Pending, version: v1}\npaths:\n  /v1/resources:\n    get:\n      responses:\n        '400': {description: Bad request}\n";
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(yamlParser.load(source));
    const selected = rules.filter((rule) => ["checkCompatibility", "checkIncompatibleChangeVersioning", "checkSuccessResponse"]
        .includes(rule.call.function));
    await select(selected);
    await upload(source);
    await loaded(source);
    expect(container.textContent).toContain("Checking Gitea connection.");
    expect(container.textContent).toContain("Missing: 200");
    expect(fetchSpecFromGitea).not.toHaveBeenCalled();
    const mute = [...container.querySelectorAll<HTMLElement>("button")].find((element) =>
        element.getAttribute("aria-label")?.startsWith("Mute "));
    if (!mute) throw new Error("Expected local finding mute control");
    await act(async () => mute.click());
    expect(container.textContent).toContain("Muted issues (1)");
    await act(async () => finish());
    await waitFor(() => jest.mocked(fetchSpecFromGitea).mock.calls.length === 1 &&
        !container.textContent?.includes("Validating specification..."));
    expect(container.textContent).not.toContain("Checking Gitea connection.");
    expect(container.textContent).not.toContain("Gitea checks skipped");
    expect(container.textContent).toContain("Muted issues (1)");
    expect(editor().state.doc.toString()).toBe(source);
    expect(lint.mock.calls.at(-1)?.[0]).toBe(selected);
});

test("failed startup probes skip the first and later baseline loads until a successful explicit retry", async () => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    await restartWithProbe(async () => {
        throw new Error("__TURBOPACK__imported__module__.giteaClient.checkAvailability is not a function");
    });
    jest.mocked(checkGiteaAvailability).mockClear();
    const selected = rules.filter((rule) => ["checkCompatibility", "checkIncompatibleChangeVersioning", "checkSuccessResponse"]
        .includes(rule.call.function));
    const source = "openapi: 3.0.3\ninfo: {title: Offline, version: v1}\npaths:\n  /v1/resources:\n    get:\n      responses:\n        '400': {description: Bad request}\n";
    await select(selected);
    await upload(source);
    await loaded(source);
    expect(container.textContent).toContain("Gitea checks skipped (SKIP).");
    expect(container.textContent).toContain("Could not connect to Gitea.");
    expect(container.textContent).not.toContain("__TURBOPACK__");
    expect(container.textContent).not.toContain("is not a function");
    expect(container.textContent).toContain("Missing: 200");
    await upload(`# next file\n${source}`);
    await loaded(`# next file\n${source}`);
    expect(fetchSpecFromGitea).not.toHaveBeenCalled();
    expect(checkGiteaAvailability).not.toHaveBeenCalled();
    await act(async () => button("Retry Gitea connection").click());
    await waitFor(() => Boolean(container.textContent?.includes("Gitea checks skipped (SKIP).")));
    expect(checkGiteaAvailability).toHaveBeenCalledTimes(1);
    expect(fetchSpecFromGitea).not.toHaveBeenCalled();
    jest.mocked(checkGiteaAvailability).mockResolvedValue(undefined);
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "local-test" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(yamlParser.load(source));
    await act(async () => button("Retry Gitea connection").click());
    await waitFor(() => jest.mocked(fetchSpecFromGitea).mock.calls.length === 1 &&
        !container.textContent?.includes("Validating specification..."));
    expect(checkGiteaAvailability).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Gitea checks skipped");
});

test("issue exclusions imported during startup are matched after the final automatic validation", async () => {
    let finish: () => void = () => { throw new Error("Probe has not started"); };
    const probe = new Promise<void>((resolve) => { finish = resolve; });
    await restartWithProbe(() => probe);
    const rule = rules[0];
    const source = "openapi: 3.0.3\ninfo: {}\npaths: {}\n";
    await upload(source);
    await loaded(source);
    await act(async () => {
        mockSelector.onExclusionsImported([{ rule_id: rule.id, line_number: 1 }]);
        mockSelector.onSelectionChange([rule]);
    });
    expect(container.textContent).toContain("Checking Gitea connection.");
    lint.mockImplementation(() => async () => ({
        diagnostics: [{ ...finding("Late baseline finding"), source: `Rule ${rule.id}` }],
    }));
    await act(async () => finish());
    await waitFor(() => Boolean(container.textContent?.includes("Muted issues (1)")));
    expect(container.textContent).not.toContain("Late baseline finding");
    expect(container.textContent).not.toContain("Checking Gitea connection.");
});

function exclusionsJson(): ApiExclusions {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="API exclusions JSON"]');
    if (!textarea) throw new Error("Missing API exclusions JSON");
    return JSON.parse(textarea.value);
}
async function editReason(label: string, value: string) {
    const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!input || !setter) throw new Error(`Missing reason input ${label}`);
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test("imported and edited exclusion reasons round-trip without revalidation or marking excluded manual checks passed", async () => {
    const [first, second] = rules;
    lint.mockImplementation(() => async () => ({ diagnostics: [{ ...finding(first.id), source: `Rule ${first.id}` }] }));
    await select([first]);
    await upload("openapi: 3.0.3\ninfo: {}\npaths: {}\n");
    await loaded("openapi: 3.0.3\ninfo: {}\npaths: {}\n");
    const imported: ApiExclusions = {
        ruleset: "default",
        exclude_auto_rules: [{ rule_id: second.id, reason: "Existing exception" }],
        exclude_manual_rules: [{ rule_id: "MANUAL-1", reason: "Not applicable" }],
        exclude_issues: [{ rule_id: first.id, line_number: 1, reason: "Intentional schema" }],
    };
    await act(async () => {
        mockManualSelector.onManualRulesChange([{ id: "MANUAL-1", title: "Manual", message: "Manual", verified: true }]);
        mockSelector.onRuleExclusionsImported(imported);
        mockSelector.onExclusionsImported(imported.exclude_issues);
        mockSelector.onSelectionChange([first]);
    });
    await waitFor(() => Boolean(container.textContent?.includes("Muted issues (1)")));
    await act(async () => button("Muted issues (1)").click());
    expect(mockManualSelector.excludedRules).toEqual(imported.exclude_manual_rules);
    const calls = lint.mock.calls.length;
    await editReason(`Exclusion reason for automatic ${second.id}`, "Service ");
    expect(container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="Exclusion reason for automatic ${second.id}"]`)?.value).toBe("Service ");
    await editReason(`Exclusion reason for automatic ${second.id}`, "Service specific");
    await editReason("Exclusion reason for manual MANUAL-1", "External checklist");
    await editReason(`Exclusion reason for ${first.id} on line 1`, "Known false positive");
    const json = exclusionsJson();
    expect(json.exclude_auto_rules).toContainEqual({ rule_id: second.id, reason: "Service specific" });
    expect(json.exclude_manual_rules).toEqual([{ rule_id: "MANUAL-1", reason: "External checklist" }]);
    expect(json.exclude_issues).toEqual([{ rule_id: first.id, line_number: 1, reason: "Known false positive" }]);
    expect(parseApiExclusions(JSON.stringify(json))).toEqual(json);
    expect(lint).toHaveBeenCalledTimes(calls);
    await closeDialog();
    for (const [label, exporter] of [
        ["Export to PDF", exportPDF], ["Export to Robot Framework", exportRobotFramework], ["Export to ReportPortal", exportReportPortal],
    ] as const) {
        await act(async () => button("Export").click());
        await act(async () => button(label).click());
        expect(jest.mocked(exporter).mock.calls.at(-1)?.[2]).toEqual([]);
    }
    await act(async () => mockSelector.onRuleExclusionsImported({
        ruleset: "default", exclude_auto_rules: [], exclude_issues: [],
    }));
    expect(mockManualSelector.excludedRules).toEqual([{ rule_id: "MANUAL-1", reason: "External checklist" }]);
    await act(async () => mockSelector.onRuleExclusionsImported({
        ruleset: "default", exclude_auto_rules: [], exclude_manual_rules: [], exclude_issues: [],
    }));
    expect(mockManualSelector.excludedRules).toEqual([]);
});
async function closeDialog() {
    await act(async () => container.querySelector("scale-modal")?.dispatchEvent(new CustomEvent("scale-close")));
}

test("imported issue mutes replace previous mutes and ignore absent findings after validating the imported rules", async () => {
    const [first, second] = rules;
    const source = "openapi: 3.0.3\ninfo: {}\npaths: {}\n";
    lint.mockImplementation((selected: AutoRule[]) => async () => ({ diagnostics: selected.flatMap((rule) => [
        { ...finding(rule.id), source: `Rule ${rule.id}`, from: 0, to: 1 },
    ]) }));
    await select([first]);
    await upload(source);
    await loaded(source);
    await act(async () => button(`Mute ${first.id} on line 1`).click());
    await act(async () => {
        mockSelector.onRulesetChange("imported");
        mockSelector.onRulesLoaded([first, second]);
        mockSelector.onSelectionChange([first, second]);
        mockSelector.onExclusionsImported([
            { rule_id: second.id, line_number: 1 },
            { rule_id: first.id, line_number: 2 },
            { rule_id: second.id, line_number: 900 },
            { rule_id: "NO-LONGER-EXISTS", line_number: 1 },
        ]);
    });
    await waitFor(() => Boolean(container.textContent?.includes("Muted issues (1)")));
    expect(container.querySelectorAll(".issuePreview")).toHaveLength(1);
    expect(container.querySelector(".issuePreview")?.textContent).toBe(first.id);
    await act(async () => button("Muted issues (1)").click());
    expect(exclusionsJson()).toEqual({
        ruleset: "imported", exclude_auto_rules: [], exclude_manual_rules: [], exclude_issues: [{ rule_id: second.id, line_number: 1 }],
    });
    await closeDialog();
    await act(async () => {
        mockSelector.onSelectionChange([first, second]);
        mockSelector.onExclusionsImported([{ rule_id: "UNKNOWN", line_number: 1 }]);
    });
    await waitFor(() => container.querySelectorAll(".issuePreview").length === 2);
    expect(container.textContent).not.toContain("Muted issues (");
});

test("muting uses rule and line across UI, gutter and all reports; exports unchecked rules and reversible API selectors", async () => {
    const [first, second] = rules;
    const source = "openapi: 3.0.3\ninfo: {}\npaths: {}\n";
    const entries: Diagnostic[] = [
        { ...finding("first finding"), source: `Rule ${first.id}`, from: 0, to: 1 },
        { ...finding("same rule and line"), source: `Rule ${first.id}`, from: 1, to: 2 },
        { ...finding("same rule, another line"), source: `Rule ${first.id}`, from: source.indexOf("info:"), to: source.indexOf("info:") + 1 },
        { ...finding("another rule"), source: `Rule ${second.id}`, from: 0, to: 1 },
    ];
    lint.mockImplementation(() => async () => ({ diagnostics: entries }));
    await select([first, second]);
    await upload(source);
    await loaded(source);
    const lintCalls = lint.mock.calls.length;
    const selection = editor().state.selection;
    const muteButton = button(`Mute ${first.id} on line 1`);
    const issueRow = muteButton.closest("tr");
    const detailsButton = issueRow?.querySelector('button[aria-label^="Details for issue"]');
    expect(detailsButton).not.toBeNull();
    expect(detailsButton?.closest("td")).not.toBe(muteButton.closest("td"));
    expect(issueRow?.querySelectorAll("td")).toHaveLength(6);
    expect(Array.from(container.querySelectorAll(".issuesTable th")).slice(-2).map((header) => header.textContent))
        .toEqual(["Details", "Mute"]);
    await act(async () => muteButton.click());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(diagnosticCount(editor().state)).toBe(2);
    expect(editor().state.selection.eq(selection)).toBe(true);
    expect(lint).toHaveBeenCalledTimes(lintCalls);
    for (const [label, exporter] of [
        ["Export to PDF", exportPDF], ["Export to Robot Framework", exportRobotFramework], ["Export to ReportPortal", exportReportPortal],
    ] as const) {
        await act(async () => button("Export").click());
        await act(async () => button(label).click());
        const call = jest.mocked(exporter).mock.calls.at(-1);
        expect(call?.[0].map((diagnostic: Diagnostic) => diagnostic.message)).toEqual(["same rule, another line", "another rule"]);
        expect(Object.values(call?.[1] ?? {}).map((rule: AutoRule) => rule.id)).toEqual([first.id, second.id]);
    }
    await act(async () => button(`Mute ${first.id} on line 2`).click());
    await act(async () => button("Export").click());
    await act(async () => button("API exclusions JSON").click());
    const config = exclusionsJson();
    expect(config).toEqual({
        ruleset: "default",
        exclude_manual_rules: [],
        exclude_auto_rules: rules.filter((rule) => ![first.id, second.id].includes(rule.id)).map((rule) => rule.id),
        exclude_issues: [{ rule_id: first.id, line_number: 1 }, { rule_id: first.id, line_number: 2 }],
    });
    expect(config.exclude_auto_rules).toContain(rules.find((rule) =>
        rule.option.toLowerCase() !== "mandatory" && rule.id !== first.id && rule.id !== second.id)?.id);
    const mutedRows = container.querySelectorAll(".mutedIssuesTable tbody tr");
    expect(mutedRows).toHaveLength(2);
    expect([...mutedRows].map((row) => [row.children[0].textContent, row.children[1].textContent]))
        .toEqual([[first.id, "1"], [first.id, "2"]]);
    await act(async () => button("Copy JSON").click());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify(config, null, 2));
    expect(container.textContent).toContain("Exclusions copied.");
    await closeDialog();
    for (const [label, exporter] of [
        ["Export to PDF", exportPDF], ["Export to Robot Framework", exportRobotFramework], ["Export to ReportPortal", exportReportPortal],
    ] as const) {
        await act(async () => button("Export").click());
        await act(async () => button(label).click());
        const call = jest.mocked(exporter).mock.calls.at(-1);
        expect(call?.[0].map((diagnostic: Diagnostic) => diagnostic.message)).toEqual(["another rule"]);
        expect(Object.values(call?.[1] ?? {}).map((rule: AutoRule) => rule.id)).toEqual([second.id]);
    }
    await act(async () => button("Muted issues (3)").click());
    await act(async () => button(`Unmute ${first.id} on line 1`).click());
    expect(document.activeElement).toBe(container.querySelector('textarea[aria-label="API exclusions JSON"]'));
    expect(exclusionsJson().exclude_issues).toEqual([{ rule_id: first.id, line_number: 2 }]);
    const restoredMessages: string[] = [];
    forEachDiagnostic(editor().state, (diagnostic) => restoredMessages.push(diagnostic.message));
    expect(restoredMessages.sort()).toEqual(["first finding", "same rule and line", "another rule"].sort());
    await act(async () => button("Unmute all issues").click());
    expect(exclusionsJson().exclude_issues).toEqual([]);
    await closeDialog();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    const allMessages: string[] = [];
    forEachDiagnostic(editor().state, (diagnostic) => allMessages.push(diagnostic.message));
    expect(allMessages.sort()).toEqual(entries.map((diagnostic) => diagnostic.message).sort());
    expect(lint).toHaveBeenCalledTimes(lintCalls);
});

test.each(["edit", "same file", "another file", "ruleset"])("issue mutes reset on %s, but not on rule selection", async (change) => {
    const rule = rules[0];
    const source = "openapi: 3.0.3\ninfo: {}\npaths: {}\n";
    lint.mockImplementation(() => async () => ({ diagnostics: [{ ...finding("mutable issue"), source: `Rule ${rule.id}` }] }));
    await select([rule]);
    await upload(source);
    await loaded(source);
    await act(async () => button("Details").click());
    await act(async () => button("Mute this rule on this line").click());
    expect(container.textContent).toContain("No unmuted issues.");
    expect(container.textContent).not.toContain("No lint issues.");
    expect(diagnosticCount(editor().state)).toBe(0);
    await select([rule]);
    expect(container.textContent).toContain("No unmuted issues.");
    if (change === "edit") {
        await act(async () => editor().dispatch({ changes: { from: 0, insert: "# changed\n" } }));
        await loaded(`# changed\n${source}`);
    } else if (change === "ruleset") {
        await act(async () => mockSelector.onRulesetChange("other"));
    } else {
        await upload(source, change === "same file" ? "native.yaml" : "another.yaml");
        await loaded(source);
    }
    await waitFor(() => diagnosticCount(editor().state) === 1);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).not.toContain("Muted issues (");
});

test("API exclusions include every unchecked rule when none are selected and clipboard failures are explicit", async () => {
    await select([]);
    await act(async () => button("Export").click());
    await act(async () => button("API exclusions JSON").click());
    expect(exclusionsJson().exclude_auto_rules).toEqual(rules.map((rule) => rule.id));
    jest.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => button("Copy JSON").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Select and copy the JSON below manually.");
    expect(console.error).toHaveBeenCalledWith("Unable to copy API exclusions", expect.any(Error));
});

test("API exclusions cannot be exported from a catalog that is still loading", async () => {
    await act(async () => mockSelector.onRulesLoaded(null));
    await act(async () => button("Export").click());
    expect(button("API exclusions JSON").hasAttribute("disabled")).toBe(true);
    await act(async () => button("API exclusions JSON").click());
    expect(container.querySelector('textarea[aria-label="API exclusions JSON"]')).toBeNull();
    expect(container.textContent).toContain("Load a ruleset to export API exclusions.");
});

test("parser diagnostics cannot be muted", async () => {
    lint.mockImplementation(() => async () => ({ diagnostics: [{ ...finding("Invalid document"), source: "parser" }] }));
    await upload("paths: [");
    await loaded("paths: [");
    expect(container.querySelector("tbody tr")?.textContent).toContain("Invalid document");
    expect(container.querySelector('button[aria-label^="Mute "]')).toBeNull();
    await act(async () => button("Details").click());
    expect(container.textContent).not.toContain("Mute this rule on this line");
});

test.each<Dialect>(["swagger2", "openapi3"])("%s upload runs all 67 real native bindings with no converter or upload HTTP", async (dialect) => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    const content = `# authored source\n${readFixtureContent(dialect)}`;
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "native", filename: "native" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(yamlParser.load(content, { json: true }));
    await select(rules);
    jest.clearAllMocks();
    await upload(content);
    await loaded(content);
    expect(lint).toHaveBeenCalledTimes(1);
    expect(lint).toHaveBeenCalledWith(rules, expect.any(Function));
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("execution failed");
    expect(container.textContent).not.toContain("Converted Swagger");
    expect(editor().state.doc.toString()).toContain(dialect === "swagger2" ? "definitions:" : "components:");
    const gutterMessages: string[] = [];
    forEachDiagnostic(editor().state, (diagnostic) => gutterMessages.push(diagnostic.message));
    const tableMessages = [...container.querySelectorAll("tbody tr")].map((row) => row.children[2].textContent);
    expect(gutterMessages.sort()).toEqual(tableMessages.sort());
    for (const [label, exporter] of [
        ["Export to PDF", exportPDF], ["Export to Robot Framework", exportRobotFramework], ["Export to ReportPortal", exportReportPortal],
    ] as const) {
        await act(async () => button("Export").click());
        await act(async () => button(label).click());
        const call = jest.mocked(exporter).mock.calls.at(-1);
        if (!call) throw new Error(`Missing export: ${label}`);
        expect(call[0].map((diagnostic: Diagnostic) => diagnostic.message).sort()).toEqual(tableMessages.sort());
        expect(Object.values(call[1]).map((rule: AutoRule) => rule.id).sort())
            .toEqual(coverageLedger.map((entry) => entry.ruleId).sort());
        expect(call[3].current).toBe(editor());
    }
});

test.each<Dialect>(["swagger2", "openapi3"])("%s pasted into the real editor uses native linting without an upload request", async (dialect) => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    await select(rules.filter((rule) => ["checkOASVersion", "checkOASSpec"].includes(rule.call.function)));
    jest.clearAllMocks();
    const content = readFixtureContent(dialect);
    await act(async () => editor().dispatch({
        changes: { from: 0, to: editor().state.doc.length, insert: content }, userEvent: "input.paste",
    }));
    await loaded(content);
    expect(lint).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(editor().state.doc.toString()).toContain(dialect === "swagger2" ? "definitions:" : "components:");
    expect(container.textContent).not.toContain("Converted Swagger");
});

describe.each<Dialect>(["swagger2", "openapi3"])("%s editor reference navigation", (dialect) => {
    const cases = (["yaml", "flow", "json"] as const).flatMap((format) =>
        (["ctrlKey", "metaKey"] as const).map((modifier) => ({ format, modifier })));
    test.each(cases)("$format $modifier+click navigates without changing or revalidating the document", async ({ format, modifier }) => {
        const content = referenceContent(dialect, format);
        await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: content } }));
        await loaded(content);
        const view = editor();
        const lintCalls = lint.mock.calls.length;
        const before = view.state.selection;
        const link = view.dom.querySelector<HTMLElement>(".cm-openapi-ref");
        if (!link) throw new Error("Missing editor reference link");
        await act(async () => link.click());
        expect(view.state.selection.eq(before)).toBe(true);
        await followReference(modifier);
        const anchor = view.state.selection.main.anchor;
        const key = format === "json" ? '"UserIdInQuery"' : "UserIdInQuery";
        expect(anchor).toBe(view.state.doc.toString().lastIndexOf(key));
        expect(view.hasFocus).toBe(true);
        expect(view.state.doc.toString()).toBe(content);
        expect(lint).toHaveBeenCalledTimes(lintCalls);
    });
});

test("reference navigation decodes escaped and percent-encoded JSON Pointer tokens", async () => {
    const name = "User/Id~ \u00e9";
    const content = JSON.stringify({
        openapi: "3.0.3",
        paths: { "/users": { get: { parameters: [{ $ref: "#/components/parameters/User~1Id~0%20%C3%A9" }] } } },
        components: { parameters: { [name]: { name: "user_id", in: "query", schema: { type: "string" } } } },
    }, null, 2);
    await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: content } }));
    await loaded(content);
    await followReference();
    expect(editor().state.selection.main.anchor).toBe(content.lastIndexOf(JSON.stringify(name)));
});

test("reference navigation refreshes offsets after edits and reveals folded definitions", async () => {
    const content = referenceContent("openapi3", "yaml");
    await upload(content);
    await loaded(content);
    const view = editor();
    const shifted = `# added source context\n${content}`;
    await act(async () => view.dispatch({ changes: { from: 0, insert: "# added source context\n" } }));
    await loaded(shifted);
    await act(async () => view.dispatch({ effects: foldEffect.of({
        from: shifted.indexOf("components:") + "components:".length, to: view.state.doc.length,
    }) }));
    expect(foldedRanges(view.state).size).toBe(1);
    await followReference();
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.state.selection.main.anchor).toBe(shifted.lastIndexOf("UserIdInQuery"));
});

test("missing, invalid, external and malformed references do not create navigation links or disable recovery", async () => {
    const content = referenceContent("openapi3", "yaml");
    const reference = "#/components/parameters/UserIdInQuery";
    for (const replacement of [
        "#/components/parameters/Missing", "#/components/parameters/Invalid~2",
        "other.yaml#/parameters/UserIdInQuery", "https://example.invalid/spec.yaml#/parameters/UserIdInQuery",
    ]) {
        const changed = content.replace(reference, replacement);
        await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: changed } }));
        await loaded(changed);
        expect(editor().dom.querySelector(".cm-openapi-ref")).toBeNull();
    }
    await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: "paths: [" } }));
    await loaded("paths: [");
    expect(editor().dom.querySelector(".cm-openapi-ref")).toBeNull();
    await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: content } }));
    await loaded(content);
    await followReference();
    expect(editor().state.selection.main.anchor).toBe(content.lastIndexOf("UserIdInQuery"));
});

test.each<Dialect>(["swagger2", "openapi3"])("%s CCE-shaped upload displays rule findings instead of stopping at the parser", async (dialect) => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    await select(rules.filter((rule) => ["checkOASVersion", "checkOASSpec", "checkSuccessResponse"].includes(rule.call.function)));
    const content = flowExampleContent(dialect);
    await upload(content);
    await loaded(content);
    expect(container.textContent).not.toContain("Specification parsing error");
    expect(container.textContent).toContain("Missing: 200");
    expect(container.textContent).toContain("STC-010-01-2507-2507-M-2");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(window.alert).not.toHaveBeenCalled();
});

test.each(["yaml", "yml"])("upload and Save preserve original %s text, CRLF, comments, definitions and refs", async (extension) => {
    const content = "# original comment\r\nswagger: '2.0'\r\ninfo: {}\r\npaths: {}\r\ndefinitions:\r\n  Alias: {$ref: '#/definitions/Target'}\r\n  Target: {type: string}\r\n";
    await upload(content, `native.${extension}`);
    await loaded(content);
    expect(fileInput().value).toBe("");
    await act(async () => button("Save").click());
    if (!savedBlob) throw new Error("Save did not create a Blob");
    expect(await blobText(savedBlob)).toBe(content);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:ui-test");
});

test.each([false, true])("unavailable baseline stays out of UI while exports retain skips (other issues: %s)", async (withOtherIssues) => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    jest.mocked(fetchRepoMap).mockResolvedValue(null);
    await select(rules.filter((rule) => rule.id.startsWith("BAS-080-") ||
        rule.id === "VER-030-01-2507-2507-O-5" || (withOtherIssues && rule.call.function === "checkSuccessResponse")));
    const content = "# vendor source\nswagger: '2.0'\ninfo: {title: Native, version: v1}\npaths:\n  /v1/resources:\n    get:\n      responses:\n        '400': {description: Bad request}\n";
    await upload(content);
    await loaded(content);
    const baseline: { from: number; to: number }[] = [];
    const others: { from: number; to: number }[] = [];
    forEachDiagnostic(editor().state, (diagnostic, from, to) => {
        if (diagnostic.source?.includes("BAS-080-") || diagnostic.source?.includes("VER-030-01-2507-2507-O-5")) {
            baseline.push({ from, to });
        } else {
            others.push({ from, to });
        }
    });
    const issueCount = withOtherIssues ? 1 : 0;
    expect(baseline).toHaveLength(0);
    expect(others).toHaveLength(issueCount);
    if (withOtherIssues) expect(others[0].from).toBeGreaterThan(0);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(issueCount);
    expect(container.textContent).toContain(`Issues (${issueCount})`);
    expect(container.textContent).toContain(`${issueCount} of ${issueCount} issues`);
    expect(container.textContent).not.toContain("Rule skipped:");
    expect(container.textContent).not.toContain("Baseline repository mapping is unavailable");
    const firstLine = container.querySelector(".cm-line");
    expect(firstLine?.querySelector(".cm-lintPoint-info, .cm-lintRange-info")).toBeNull();
    for (const [label, exporter] of [
        ["Export to PDF", exportPDF], ["Export to Robot Framework", exportRobotFramework], ["Export to ReportPortal", exportReportPortal],
    ] as const) {
        await act(async () => button("Export").click());
        expect(container.textContent).toContain(`Export all ${issueCount} issues`);
        await act(async () => button(label).click());
        const exported = jest.mocked(exporter).mock.calls.at(-1)?.[0];
        expect(exported).toHaveLength(8 + issueCount);
        expect(exported?.filter((diagnostic) => "ruleOutcome" in diagnostic && diagnostic.ruleOutcome === "skip")).toHaveLength(8);
    }
});

test("failed Gitea loads show SKIP, future uploads avoid the request, and explicit retry restores the baseline checks", async () => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "local-test", filename: "test" });
    jest.mocked(fetchSpecFromGitea).mockResolvedValue(null);
    const selected = rules.filter((rule) => ["checkCompatibility", "checkIncompatibleChangeVersioning", "checkSuccessResponse"]
        .includes(rule.call.function));
    await select(selected);
    const source = "openapi: 3.0.3\ninfo: {title: First, version: v1}\npaths:\n  /v1/resources:\n    get:\n      responses:\n        '400': {description: Bad request}\n";
    await upload(source);
    await loaded(source);
    expect(container.textContent).toContain("Gitea checks skipped (SKIP)");
    expect(container.textContent).toContain("Missing: 200");
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
    const next = source.replace("First", "Second");
    await upload(next);
    await loaded(next);
    expect(container.textContent).toContain("Gitea checks skipped (SKIP)");
    expect(container.textContent).toContain("Missing: 200");
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
    await act(async () => button("Export").click());
    await act(async () => button("Export to Robot Framework").click());
    const exported = jest.mocked(exportRobotFramework).mock.calls.at(-1)?.[0];
    expect(exported?.filter((entry) => "ruleOutcome" in entry && entry.ruleOutcome === "skip")).toHaveLength(8);

    jest.mocked(fetchSpecFromGitea).mockResolvedValue(yamlParser.load(next));
    await act(async () => button("Retry Gitea connection").click());
    await waitFor(() => jest.mocked(fetchSpecFromGitea).mock.calls.length === 2 &&
        !container.textContent?.includes("Validating specification..."));
    expect(container.textContent).not.toContain("Gitea checks skipped");
    expect(container.textContent).toContain("Missing: 200");
    expect(lint.mock.calls.at(-1)?.[0]).toBe(selected);
    expect(editor().state.doc.toString()).toBe(next);
});

test("reuploading exactly the same file revalidates and refreshes both the table and gutter", async () => {
    let runs = 0;
    lint.mockImplementation(() => async () => ({ diagnostics: [finding(`result ${++runs}`)] }));
    const content = "swagger: '2.0'\ninfo: {}\npaths: {}\n";
    await upload(content);
    await loaded(content);
    expect(container.textContent).toContain("result 1");
    await upload(content);
    await waitFor(() => Boolean(container.textContent?.includes("result 2")));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    expect(lint).toHaveBeenCalledTimes(3); // initial editor run plus two uploads
    expect(diagnosticCount(editor().state)).toBe(1);
});

test("late old file reads cannot replace a newer upload", async () => {
    const readers = controlledReaders();
    await upload("first", "first.yaml");
    await upload("second", "second.yaml");
    await finishRead(readers[1], "swagger: '2.0'\ninfo: {title: New}\npaths: {}\n");
    const expected = editor().state.doc.toString();
    await finishRead(readers[0], "openapi: 3.0.3\ninfo: {title: Old}\npaths: {}\n");
    expect(editor().state.doc.toString()).toBe(expected);
    expect(window.alert).not.toHaveBeenCalled();
});

test("late lint results from an old upload cannot replace table, gutter or exported title", async () => {
    const pending = new Map<string, (result: LintResult) => void>();
    lint.mockImplementation(() => (view) => new Promise((resolve) => pending.set(view.state.doc.toString(), resolve)));
    const first = "swagger: '2.0'\ninfo: {title: Old}\npaths: {}\n";
    const second = first.replace("Old", "New");
    await upload(first);
    await waitFor(() => pending.has(first));
    await upload(second);
    await waitFor(() => pending.has(second));
    await act(async () => pending.get(second)!({ diagnostics: [finding("latest finding")], specTitle: "New" }));
    await act(async () => pending.get(first)!({ diagnostics: [finding("stale finding")], specTitle: "Old" }));
    expect(container.textContent).toContain("latest finding");
    expect(container.textContent).not.toContain("stale finding");
    expect(diagnosticCount(editor().state)).toBe(1);
    await act(async () => button("Export").click());
    await act(async () => button("Export to ReportPortal").click());
    expect(jest.mocked(exportReportPortal).mock.calls.at(-1)?.[4]?.launch).toBe("Service: New");
});

test("same-length edits ignore stale lint results and keep diagnostic navigation functional", async () => {
    const pending: ((result: LintResult) => void)[] = [];
    lint.mockImplementation(() => () => new Promise((resolve) => pending.push(resolve)));
    await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: "first" } }));
    await act(async () => editor().dispatch({ changes: { from: 0, to: 5, insert: "other" } }));
    await act(async () => pending[1]({ diagnostics: [{ ...finding("new edit"), from: 2, to: 3 }] }));
    await act(async () => pending[0]({ diagnostics: [finding("old edit")] }));
    expect(container.textContent).toContain("new edit");
    expect(container.textContent).not.toContain("old edit");
    const row = container.querySelector<HTMLElement>("tbody tr");
    if (!row) throw new Error("Missing diagnostic row");
    await act(async () => row.click());
    expect(editor().state.selection.main.head).toBe(2);
    await act(async () => button("Save").click());
    if (!savedBlob) throw new Error("Save did not create a Blob");
    expect(await blobText(savedBlob)).toBe("other");
});

test("switching rules ignores older results for the same document, including gutter diagnostics", async () => {
    const pending: ((result: LintResult) => void)[] = [];
    lint.mockImplementation(() => () => new Promise((resolve) => pending.push(resolve)));
    await act(async () => mockSelector.onSelectionChange([rules[0]]));
    await act(async () => mockSelector.onSelectionChange([rules[1]]));
    await act(async () => pending[1]({ diagnostics: [finding("new rules")] }));
    await act(async () => pending[0]({ diagnostics: [finding("old rules")] }));
    expect(container.textContent).toContain("new rules");
    expect(container.textContent).not.toContain("old rules");
    expect(diagnosticCount(editor().state)).toBe(1);
});

test("JSON upload remains outside the accepted extension set", async () => {
    const read = jest.spyOn(FileReader.prototype, "readAsText");
    const before = editor().state.doc.toString();
    await upload('{"swagger":"2.0"}', "native.json");
    expect(window.alert).toHaveBeenCalledWith("Please upload a valid .yaml or .yml file.");
    expect(fileInput().accept).toBe(".yaml,.yml");
    expect(fileInput().value).toBe("");
    expect(read).not.toHaveBeenCalled();
    expect(editor().state.doc.toString()).toBe(before);
});

test.each(["error", "abort"] as const)("file read %s is visible and preserves the existing document", async (event) => {
    const readers = controlledReaders();
    const before = editor().state.doc.toString();
    await upload("unreadable");
    await act(async () => {
        readers[0].dispatchEvent(new ProgressEvent(event));
        readers[0].dispatchEvent(new ProgressEvent("loadend"));
    });
    expect(window.alert).toHaveBeenCalledTimes(1);
    expect(editor().state.doc.toString()).toBe(before);
});

test("synchronous read errors are explicit and a non-text result is not accepted", async () => {
    jest.spyOn(FileReader.prototype, "readAsText").mockImplementationOnce(() => { throw new Error("Read denied"); });
    const before = editor().state.doc.toString();
    await upload("unreadable");
    expect(window.alert).toHaveBeenCalledWith("Unable to read the selected file: Read denied");
    const readers = controlledReaders();
    await upload("invalid result");
    await finishRead(readers[0], new ArrayBuffer(1));
    expect(window.alert).toHaveBeenCalledWith("Unable to read the selected file as text.");
    expect(editor().state.doc.toString()).toBe(before);
});

test("malformed uploaded YAML reaches parser diagnostics rather than upload conversion", async () => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    await select(rules.filter((rule) => rule.call.function === "checkOASVersion"));
    const content = "swagger: [";
    await upload(content);
    await loaded(content);
    expect(container.textContent).toContain("Specification parsing error");
    expect(window.alert).not.toHaveBeenCalled();
});

test("unsupported versions are retained in the editor and reported by the selected format rule", async () => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    await select(rules.filter((rule) => rule.call.function === "checkOASVersion"));
    const content = "openapi: 3.1.0\ninfo: {}\npaths: {}\n";
    await upload(content);
    await loaded(content);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).toContain("BAS-110-01-2507-2507-M");
    expect(window.alert).not.toHaveBeenCalled();
});

test("unexpected lint failure is not displayed as a successful empty result", async () => {
    lint.mockImplementation(() => async () => { throw new Error("Validation unavailable"); });
    await upload("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    await waitFor(() => Boolean(container.querySelector("[role=alert]")));
    expect(container.textContent).toContain("Unable to validate the specification: Validation unavailable");
    expect(container.textContent).not.toContain("No lint issues.");
    expect(button("Export").hasAttribute("disabled")).toBe(true);
    await act(async () => button("Export").click());
    expect(container.textContent).not.toContain("Export to ReportPortal");
});

test("switching workspace tabs preserves the editor, diagnostics and rule selection without revalidation", async () => {
    await select([rules[0]]);
    await upload("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    await loaded("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    const view = editor();
    const calls = lint.mock.calls.length;
    for (const tab of ["rules", "manual", "issues"]) {
        const element = container.querySelector<HTMLElement>(`scale-tab-header[data-tab=${tab}]`);
        if (!element) throw new Error(`Missing tab ${tab}`);
        await act(async () => element.click());
        expect(element.nextElementSibling?.hasAttribute("hidden")).toBe(false);
    }
    expect(editor()).toBe(view);
    expect(lint).toHaveBeenCalledTimes(calls);
});

test("issue display filters and pagination never truncate exports or editor diagnostics", async () => {
    const all = Array.from({ length: 105 }, (_, index) => ({
        ...finding(`Issue ${index}`), severity: index % 2 ? "warning" as const : "error" as const,
    }));
    lint.mockImplementation(() => async () => ({ diagnostics: all }));
    await upload("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    await loaded("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(100);
    const severity = container.querySelector<HTMLScaleDropdownSelectElement>('scale-dropdown-select[label="Severity"]');
    if (!severity) throw new Error("Missing severity filter");
    await act(async () => {
        severity.value = "critical";
        severity.dispatchEvent(new CustomEvent("scale-change"));
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(53);
    const editorDiagnostics: Diagnostic[] = [];
    forEachDiagnostic(editor().state, (diagnostic) => editorDiagnostics.push(diagnostic));
    expect(editorDiagnostics).toHaveLength(105);
    await act(async () => button("Export").click());
    await act(async () => button("Export to Robot Framework").click());
    expect(jest.mocked(exportRobotFramework).mock.calls.at(-1)?.[0]).toEqual(all);
});

test("issue navigation retains exact EOF positions", async () => {
    const content = "swagger: [";
    lint.mockImplementation(() => async () => ({ diagnostics: [{
        ...finding("EOF problem"), from: content.length, to: content.length,
    }] }));
    await upload(content);
    await loaded(content);
    const row = container.querySelector<HTMLElement>("tbody tr");
    if (!row) throw new Error("Missing EOF diagnostic");
    await act(async () => row.click());
    expect(editor().state.selection.main.head).toBe(content.length);
});

test("a real CodeMirror gutter click reveals an issue hidden by display filters", async () => {
    lint.mockImplementation(() => async () => ({ diagnostics: [finding("Gutter issue")] }));
    await upload("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    await loaded("swagger: '2.0'\ninfo: {}\npaths: {}\n");
    const severity = container.querySelector<HTMLScaleDropdownSelectElement>('scale-dropdown-select[label="Severity"]');
    if (!severity) throw new Error("Missing severity filter");
    await act(async () => {
        severity.value = "low";
        severity.dispatchEvent(new CustomEvent("scale-change"));
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    await waitFor(() => Boolean(container.querySelector(".cm-gutter-lint .cm-lint-marker")));
    const marker = container.querySelector<HTMLElement>(".cm-gutter-lint .cm-lint-marker");
    if (!marker) throw new Error("Missing lint gutter marker");
    await act(async () => marker.click());
    expect(container.querySelector("tr[data-active=true]")?.textContent).toContain("Gutter issue");
    expect(container.querySelector('[data-tab="issues"]')?.nextElementSibling?.hasAttribute("hidden")).toBe(false);
});

test("unmount cancels pending reads and ignores already queued load events", async () => {
    const readers = controlledReaders();
    await upload("pending file");
    await act(async () => root.unmount());
    expect(FileReader.prototype.abort).toHaveBeenCalled();
    await finishRead(readers[0], "swagger: '2.0'\npaths: {}\n");
    expect(window.alert).not.toHaveBeenCalled();
});
