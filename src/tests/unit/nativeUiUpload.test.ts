/** @jest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs/promises";
import path from "node:path";
import * as yamlParser from "js-yaml";
import { EditorView } from "@codemirror/view";
import { diagnosticCount, forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import HomePage from "@/app/page";
import { openApiLinter } from "@/components/Linter";
import { functionsMap } from "@/lib/linter/runLinter";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { setAllowedAbbreviations } from "@/utils/englishWords";
import { parseAllowedAbbreviations } from "@/lib/abbreviations";
import { exportJUnit, exportPDF, exportReportPortal } from "@/utils/export";
import { coverageLedger } from "@/tests/fixtures/dual-version/coverageLedger";
import { flowExampleContent, readFixtureContent, type Dialect } from "@/tests/fixtures/dual-version/scenarios";

type LintResult = Awaited<ReturnType<ReturnType<typeof openApiLinter>>>;
let mockSelector: { onSelectionChange: (rules: AutoRule[]) => void };
jest.mock("@telekom/scale-components/dist/scale-components/scale-components.css", () => ({}));
jest.mock("@telekom/scale-components/loader", () => ({
    applyPolyfills: jest.fn(async () => undefined), defineCustomElements: jest.fn(),
}));
jest.mock("@/components/AuthButtons", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ManualChecksSelector", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/RulesetsSelector", () => ({
    __esModule: true, default: (props: typeof mockSelector) => { mockSelector = props; return null; },
}));
jest.mock("@/utils/export", () => ({
    exportJUnit: jest.fn(), exportPDF: jest.fn(), exportReportPortal: jest.fn(async () => undefined),
}));
jest.mock("@/components/Linter", () => ({ openApiLinter: jest.fn() }));
jest.mock("@/utils/utils", () => ({ fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn() }));
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
    const found = [...container.querySelectorAll<HTMLElement>("scale-button")]
        .find((element) => element.textContent?.trim() === text);
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
    expect(lint).toHaveBeenCalledWith(rules);
    expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("execution failed");
    expect(container.textContent).not.toContain("Converted Swagger");
    expect(editor().state.doc.toString()).toContain(dialect === "swagger2" ? "definitions:" : "components:");
    const gutterMessages: string[] = [];
    forEachDiagnostic(editor().state, (diagnostic) => gutterMessages.push(diagnostic.message));
    const tableMessages = [...container.querySelectorAll("tbody tr")].map((row) => row.children[2].textContent);
    expect(gutterMessages.sort()).toEqual(tableMessages.sort());
    for (const [label, exporter] of [
        ["Export to PDF", exportPDF], ["Export to jUnit", exportJUnit], ["Export to ReportPortal", exportReportPortal],
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

test("unavailable baseline leaves only a point on line one without covering other validation messages", async () => {
    const actual = jest.requireActual<typeof import("@/components/Linter")>("@/components/Linter");
    lint.mockImplementation(actual.openApiLinter);
    jest.mocked(fetchRepoMap).mockResolvedValue(null);
    await select(rules.filter((rule) => rule.id.startsWith("BAS-080-") ||
        rule.id === "VER-030-01-2507-2507-O-5" || rule.call.function === "checkSuccessResponse"));
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
    expect(baseline).toEqual(Array.from({ length: 8 }, () => ({ from: 0, to: 0 })));
    expect(others).toHaveLength(1);
    expect(others[0].from).toBeGreaterThan(0);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(9);
    const firstLine = container.querySelector(".cm-line");
    expect(firstLine?.querySelector(".cm-lintPoint-error")).not.toBeNull();
    expect(firstLine?.querySelector(".cm-lintRange-error")).toBeNull();
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
    await act(async () => button("Export to jUnit").click());
    expect(jest.mocked(exportJUnit).mock.calls.at(-1)?.[0]).toEqual(all);
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
