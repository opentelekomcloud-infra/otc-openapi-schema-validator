import handler, { config } from "@/pages/api/reportportal";
import { requireApiAuth } from "@/lib/apiAuth";
import { reportPortalClient } from "@/clients/reportportal";
import { exportReportPortal } from "@/utils/export";
import { apiRequest } from "@/tests/fixtures/apiRequest";

jest.mock("@/lib/apiAuth", () => ({ requireApiAuth: jest.fn() }));
jest.mock("@/clients/reportportal", () => ({
    reportPortalClient: { importLaunch: jest.fn(), getLaunchById: jest.fn() },
}));
jest.mock("@/utils/utils", () => ({
    convertMarkdownToPlainText: (value: string) => value,
}));

const failedId = "BAS-080-01-2507-2507-M";
const passedId = "BAS-110-01-2507-2507-M";
const selected = {
    [failedId]: { id: failedId, title: "Baseline comparison" },
    [passedId]: { id: passedId, title: "Native version" },
};
const diagnostics = [{
    from: 0, to: 0, lineNumber: 1, severity: "error",
    source: `Rule ${failedId} - Baseline comparison`,
    message: "Baseline repository mapping is unavailable",
}];

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(requireApiAuth).mockResolvedValue({ mode: "disabled" });
    jest.mocked(reportPortalClient.importLaunch).mockResolvedValue('{"id":"isolated-launch"}');
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected ReportPortal network request"));
});
afterEach(() => jest.restoreAllMocks());

test("browser export crosses only the same-origin proxy and forwards the exact XML with no false baseline PASS", async () => {
    jest.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
        expect(url).toBe("/api/reportportal");
        expect(init?.headers).toEqual({ "Content-Type": "application/json" });
        if (typeof init?.body !== "string") throw new Error("Expected JSON proxy body");
        const body: unknown = JSON.parse(init.body);
        const res = await apiRequest(handler, body);
        return new Response(JSON.stringify(res.json.mock.calls[0][0]), { status: res.status.mock.calls[0][0] });
    });
    await exportReportPortal(diagnostics, selected, [], { current: null }, {
        project: "isolated", launch: "Service: Native", description: "Isolated regression",
        attributes: [{ key: "dialect", value: "swagger2" }], mode: "DEBUG",
        endpoint: "https://must-not-contact.example.invalid", apiKey: "synthetic-not-forwarded",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(reportPortalClient.importLaunch).toHaveBeenCalledWith(expect.objectContaining({
        project: "isolated", launch: "Service: Native", mode: "DEBUG",
        attributes: [{ key: "dialect", value: "swagger2" }],
    }));
    const xml = jest.mocked(reportPortalClient.importLaunch).mock.calls[0][0].xml;
    expect(xml).toContain("Line 1:");
    expect(xml).toContain(`Rule ${failedId}`);
    expect(xml.split('name="Passed Rules"')[1]).not.toContain(failedId);
    expect(xml.split('name="Passed Rules"')[1]).toContain(passedId);
    expect(xml).not.toContain("synthetic-not-forwarded");
});

test("both proxy methods require authorization before touching ReportPortal", async () => {
    jest.mocked(requireApiAuth).mockResolvedValue(null);
    for (const method of ["POST", "GET"]) {
        expect((await apiRequest(handler, {}, method)).status).toHaveBeenCalledWith(401);
    }
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
    expect(reportPortalClient.getLaunchById).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("lookup forwards the project and launch ID without performing an import", async () => {
    jest.mocked(reportPortalClient.getLaunchById).mockResolvedValue({ id: 42 });
    const res = await apiRequest(handler, {}, "GET", { project: "isolated", launchId: "42" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id: 42 });
    expect(reportPortalClient.getLaunchById).toHaveBeenCalledWith({ project: "isolated", launchId: "42" });
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
});

test("proxy transport failures reach the browser instead of reporting export success", async () => {
    jest.mocked(reportPortalClient.importLaunch).mockRejectedValue(new Error("Controlled proxy failure"));
    jest.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected JSON proxy body");
        const res = await apiRequest(handler, JSON.parse(init.body));
        return new Response(JSON.stringify(res.json.mock.calls[0][0]), { status: res.status.mock.calls[0][0] });
    });
    await expect(exportReportPortal(diagnostics, selected, [], { current: null }, {
        project: "isolated", launch: "Service: Native",
    })).rejects.toThrow("Controlled proxy failure");
    expect(console.error).toHaveBeenCalled();
});

test("method, required fields and body-size boundaries are preserved", async () => {
    expect(config.api.bodyParser.sizeLimit).toBe("10mb");
    expect((await apiRequest(handler, {}, "DELETE")).status).toHaveBeenCalledWith(405);
    expect((await apiRequest(handler, {})).status).toHaveBeenCalledWith(400);
    expect((await apiRequest(handler, {}, "GET")).status).toHaveBeenCalledWith(400);
    expect(reportPortalClient.importLaunch).not.toHaveBeenCalled();
});
