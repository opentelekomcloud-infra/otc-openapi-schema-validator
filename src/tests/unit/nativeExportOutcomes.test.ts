/** @jest-environment jsdom */
import fs from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import type { Diagnostic } from "@codemirror/lint";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { buildRobotXml } from "@/lib/export/buildRobotXml";
import { diagnosticRuleId, ruleOutcomeSummary } from "@/lib/export/ruleOutcomes";
import { exportJUnit, exportPDF } from "@/utils/export";
import type { ManualRule } from "@/components/ManualChecksSelector";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { coverageLedger } from "@/tests/fixtures/dual-version/coverageLedger";
import { buildScenario, readFixtureContent, scenarioDefinition, type Dialect } from "@/tests/fixtures/dual-version/scenarios";

jest.mock("@/utils/utils", () => ({
    fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn(),
    convertImageFromLinkToBase64: jest.fn(async () => undefined),
    convertMarkdownToPlainText: (value: string) => value,
}));
jest.mock("jspdf/dist/jspdf.es.min.js", () => ({
    jsPDF: jest.fn(() => ({ setFontSize: jest.fn(), text: jest.fn(), save: jest.fn() })),
}));
jest.mock("jspdf-autotable/es", () => ({ autoTable: jest.fn() }));
jest.mock("swagger2openapi", () => ({
    convertStr: jest.fn(() => { throw new Error("Exports must not convert"); }),
    convertObj: jest.fn(() => { throw new Error("Exports must not convert"); }),
}), { virtual: true });

const tables = jest.requireMock<{ autoTable: jest.Mock }>("jspdf-autotable/es");
const rules = new Map<string, AutoRule>();
let savedBlob: Blob;

function parseXml(xml: string): Document {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    return parsed;
}

async function browserXml(diagnostics: Diagnostic[], selected: Record<string, AutoRule>, manual: ManualRule[] = []) {
    await exportJUnit(diagnostics, selected, manual, { current: null });
    const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Not XML"));
        reader.onerror = reject;
        reader.readAsText(savedBlob);
    });
    return parseXml(text);
}

async function reports(content: string, diagnostics: Diagnostic[], selected: Record<string, AutoRule>) {
    const api = parseXml(buildRobotXml(diagnostics, selected, [], content, true));
    const ui = await browserXml(diagnostics, selected);
    tables.autoTable.mockClear();
    await exportPDF(diagnostics, selected, [], { current: null });
    const rows: unknown[][] = tables.autoTable.mock.calls[0][1].body;
    return { api, ui, rows };
}

beforeAll(async () => {
    const root = path.join(process.cwd(), "public/rulesets/default");
    const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml")).map((file) => path.join(root, file));
    for (const rule of getImplementedRules(await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8")), functionsMap)) {
        rules.set(rule.id, rule);
    }
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: jest.fn((blob: Blob) => {
        savedBlob = blob;
        return "blob:native-export";
    }) });
});
beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(globalThis, { fetch: jest.fn(() => { throw new Error("Unexpected export network request"); }) });
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.mocked(fetchRepoMap).mockRejectedValue(new Error("Unexpected baseline lookup"));
    jest.mocked(fetchSpecFromGitea).mockRejectedValue(new Error("Unexpected baseline fetch"));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const converter = jest.requireMock<{ convertStr: jest.Mock; convertObj: jest.Mock }>("swagger2openapi");
    expect(converter.convertStr).not.toHaveBeenCalled();
    expect(converter.convertObj).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

test("export coverage ledger matches all 67 implemented bindings", () => {
    expect(coverageLedger.map((entry) => entry.ruleId).sort()).toEqual([...rules.keys()].sort());
    expect(rules.size).toBe(67);
});

describe.each(coverageLedger)("$ruleId native report outcomes", (entry) => {
    test.each<Dialect>(["swagger2", "openapi3"])("%s positive and negative outcomes retain the real ID and line", async (dialect) => {
        const rule = rules.get(entry.ruleId);
        if (!rule) throw new Error(`Missing rule ${entry.ruleId}`);
        const selected = { [rule.id]: rule };
        for (const variant of ["positive", "negative"] as const) {
            if (scenarioDefinition(entry.scenario).baseline) {
                jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "native", filename: "native" });
                jest.mocked(fetchSpecFromGitea).mockResolvedValue(buildScenario(entry.scenario, dialect, "positive", rule));
            }
            const content = `# original source\r\n${yaml.dump(buildScenario(entry.scenario, dialect, variant, rule))
                .replace(/\n/g, "\r\n")}`;
            const { diagnostics } = await runLinter(content, [rule]);
            expect(diagnostics).toHaveLength(variant === "positive" ? 0 : 1);
            expect(diagnostics.some((diagnostic) => diagnostic.message.includes("execution failed"))).toBe(false);
            const { api, ui, rows } = await reports(content, diagnostics, selected);
            for (const xml of [api, ui]) {
                expect(xml.querySelectorAll('suite[name="Passed Rules"] test')).toHaveLength(variant === "positive" ? 1 : 0);
                expect(xml.querySelectorAll("test > status[status=FAIL]")).toHaveLength(variant === "positive" ? 0 : 1);
                expect(xml.documentElement.textContent).toContain(variant === "positive" ? "Passed" : diagnostics[0].message);
                expect(xml.documentElement.outerHTML).toContain(rule.id);
            }
            if (variant === "positive") {
                expect(rows).toEqual([["Passed", rule.message, rule.severity, rule.id]]);
            } else {
                expect(diagnosticRuleId(diagnostics[0])).toBe(rule.id);
                expect(rows).toHaveLength(1);
                expect(rows[0][0]).toBe(diagnostics[0].lineNumber);
                expect(rows[0][3]).toContain(rule.id);
                expect(api.documentElement.textContent).toContain(`Line ${diagnostics[0].lineNumber}:`);
                expect(ui.querySelector("test")?.getAttribute("name")).toBe(`Line: ${diagnostics[0].lineNumber}`);
            }
        }
    });
});

test.each<Dialect>(["swagger2", "openapi3"])("%s baseline failures never pass the eight affected checks", async (dialect) => {
    const selected = [...rules.values()].filter((rule) => rule.id.startsWith("BAS-080-") ||
        rule.id === "VER-030-01-2507-2507-O-5" || rule.call.function === "checkOASVersion");
    jest.mocked(fetchRepoMap).mockResolvedValue(null);
    const content = readFixtureContent(dialect);
    const { diagnostics } = await runLinter(content, selected);
    expect(diagnostics).toHaveLength(8);
    expect(diagnostics.every((diagnostic) => diagnostic.from === 0 && diagnostic.lineNumber === 1)).toBe(true);
    const { api, ui, rows } = await reports(content, diagnostics, Object.fromEntries(selected.map((rule) => [rule.id, rule])));
    for (const xml of [api, ui]) {
        expect(xml.querySelectorAll('suite[name="Passed Rules"] test')).toHaveLength(1);
        expect(xml.querySelectorAll("test > status[status=FAIL]")).toHaveLength(8);
        expect(xml.querySelector('suite[name="Passed Rules"]')?.textContent).not.toContain("BAS-080-");
    }
    expect(rows.filter((row) => row[0] === "Passed")).toHaveLength(1);
    expect(rows.filter((row) => row[0] === 1)).toHaveLength(8);
});

test("generic execution errors fail only their own rule rather than reporting it as passed", async () => {
    const selected = [...rules.values()].filter((rule) => ["checkOASVersion", "checkOASSpec"].includes(rule.call.function));
    jest.spyOn(functionsMap, "checkOASVersion").mockImplementation(() => { throw new Error("Controlled execution failure"); });
    const content = readFixtureContent("swagger2");
    const { diagnostics } = await runLinter(content, selected);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Controlled execution failure");
    const { api, ui, rows } = await reports(content, diagnostics, Object.fromEntries(selected.map((rule) => [rule.id, rule])));
    for (const xml of [api, ui]) {
        expect(xml.querySelectorAll('suite[name="Passed Rules"] test')).toHaveLength(1);
        expect(xml.querySelectorAll("test > status[status=FAIL]")).toHaveLength(1);
    }
    expect(rows.filter((row) => row[0] === "Passed")).toHaveLength(1);
});

test("global parser failures produce 67 unexecuted rules, never 67 passes", async () => {
    const content = "swagger: [";
    const { diagnostics } = await runLinter(content, [...rules.values()]);
    expect(diagnostics).toEqual([expect.objectContaining({ source: "parser", severity: "error" })]);
    const { api, ui, rows } = await reports(content, diagnostics, Object.fromEntries(rules));
    for (const xml of [api, ui]) {
        expect(xml.querySelector('suite[name="Passed Rules"]')).toBeNull();
        expect(xml.querySelectorAll('suite[name="Not Executed Rules"] test > status[status=SKIP]')).toHaveLength(67);
        expect(xml.querySelectorAll("test > status[status=FAIL]")).toHaveLength(1);
    }
    expect(rows.filter((row) => row[0] === "Not executed")).toHaveLength(67);
    expect(rows.some((row) => row[0] === "Passed")).toBe(false);
});

test("explicit IDs, labeled sources, message-only IDs and legacy numeric IDs have the same outcome mapping", () => {
    expect(ruleOutcomeSummary([
        { ruleId: "BAS-080-01", source: "Rule DIFFERENT-123", message: "" },
        { source: "Rule STC-010-01 - Title" },
        { source: "Unrecognized source", message: "URI-020-01: failure" },
        { source: "Rule 1.2.3 - legacy" },
    ]).failedRuleIds).toEqual(new Set(["BAS-080-01", "STC-010-01", "URI-020-01", "1.2.3"]));
});

test("shared XML escapes quoted titles and messages without changing their decoded value", () => {
    const xml = parseXml(buildRobotXml(
        [{ from: 0, to: 0, severity: "error", source: "DOC-040-01", message: 'A "quoted" & <tag> value' }],
        { "DOC-040-01": { id: "DOC-040-01", title: 'A "quoted" title' } }, [], "", true,
    ));
    expect(xml.querySelector("test")?.getAttribute("name")).toBe('Rule DOC-040-01 - A "quoted" title');
    expect(xml.querySelector("msg")?.textContent).toContain('A "quoted" & <tag> value');
});

test("all 28 manual checks retain UI verification status, PDF rows and API SKIP policy", async () => {
    const root = path.join(process.cwd(), "public/manual-checklist");
    const files = (await fs.readdir(root)).filter((file) => file.endsWith(".yaml")).map((file) => path.join(root, file));
    const manual = (await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8")))
        .map((rule, index) => ({ ...rule, verified: index % 2 === 0 }));
    expect(manual).toHaveLength(28);
    const ui = await browserXml([], {}, manual);
    const api = parseXml(buildRobotXml([], {}, manual, "", true));
    expect(ui.querySelectorAll('suite[name="Manual Checklist"] test > status[status=PASS]')).toHaveLength(14);
    expect(ui.querySelectorAll('suite[name="Manual Checklist"] test > status[status=FAIL]')).toHaveLength(14);
    expect(api.querySelectorAll('suite[name="Manual Checklist"] test > status[status=SKIP]')).toHaveLength(28);
    for (const rule of manual) {
        expect(ui.documentElement.outerHTML).toContain(rule.id);
        expect(api.documentElement.outerHTML).toContain(rule.id);
    }
    tables.autoTable.mockClear();
    await exportPDF([], {}, manual, { current: null });
    const rows: unknown[][] = tables.autoTable.mock.calls[1][1].body;
    expect(rows).toHaveLength(28);
    expect(rows.filter((row) => row[4] === "Verified")).toHaveLength(14);
    expect(rows.filter((row) => row[4] === "Unverified")).toHaveLength(14);
});
