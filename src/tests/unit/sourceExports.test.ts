import { exportJUnit, exportPDF } from "@/utils/export";
import { buildRobotXml } from "@/lib/export/buildRobotXml";
import { sourceMap } from "@/lib/openapi/sourceMap";

jest.mock("@/utils/utils", () => ({
    convertImageFromLinkToBase64: jest.fn(async () => undefined),
    convertMarkdownToPlainText: (value: unknown) => String(value ?? ""),
}));
jest.mock("jspdf/dist/jspdf.es.min.js", () => ({
    jsPDF: jest.fn(() => ({ setFontSize: jest.fn(), text: jest.fn(), save: jest.fn() })),
}));
jest.mock("jspdf-autotable/es", () => ({ autoTable: jest.fn() }));

const tables = jest.requireMock<{ autoTable: jest.Mock }>("jspdf-autotable/es");
const content = "openapi: 3.0.3\r\ninfo: {title: Example, version: v1}\r\npaths: {}\r\n";
const diagnostic = {
    ...sourceMap(content).locate("#/paths"), severity: "error" as const,
    message: "Missing source node", source: "DOC-040-01-2507-2507-M",
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Exports must not access the network."));
});
afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

test("Robot XML uses the original source line and preserves rule FAIL attribution", () => {
    const xml = buildRobotXml([{ ...diagnostic, lineNumber: 99 }], {}, [], content, true);
    expect(xml).toContain("Line 3:");
    expect(xml).not.toContain("Line 99:");
    expect(xml).toContain("DOC-040-01-2507-2507-M");
    expect(xml).toContain('status="FAIL"');
});

test("Robot XML uses recorded line metadata without a source, never a character offset as a line", () => {
    expect(buildRobotXml([diagnostic], {}, [], undefined, true)).toContain("Line 3:");
    const raw = { from: 100, to: 101, severity: "error", message: "No text", source: diagnostic.source };
    expect(buildRobotXml([raw], {}, [], undefined, true)).toContain("Line N/A:");
    expect(buildRobotXml([raw], {}, [], undefined, true)).not.toContain("Line 100:");
});

test("PDF preserves mapped line metadata when no live editor is available", async () => {
    await exportPDF([diagnostic], {}, [], { current: null });
    expect(tables.autoTable).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        body: [[3, diagnostic.message, expect.any(String), diagnostic.source]],
    }));
});

test("browser Robot export uses the same mapped line, including without a live editor", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    const anchor = { href: "", download: "", click: jest.fn() };
    Object.defineProperty(globalThis, "document", {
        configurable: true, value: { createElement: jest.fn(() => anchor) },
    });
    const createObjectURL = jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:source-map-test");
    try {
        await exportJUnit([diagnostic], {}, [], { current: null });
        expect(anchor.click).toHaveBeenCalledTimes(1);
        const blob = createObjectURL.mock.calls[0][0];
        if (!(blob instanceof Blob)) throw new Error("Expected an XML Blob");
        expect(await blob.text()).toContain('name="Line: 3"');
    } finally {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else Reflect.deleteProperty(globalThis, "document");
    }
});
