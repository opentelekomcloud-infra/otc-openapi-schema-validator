import axios from "axios";
import JSZip from "jszip";
import { createServer } from "node:http";
import type { ReportPortalClient } from "@/clients/reportportal";

let Client: typeof ReportPortalClient;
let client: ReportPortalClient;
let sharedClient: ReportPortalClient;
let restoreEnvironment: () => void;
const proxy = {
    protocol: "http", host: "127.0.0.1", port: 3128,
    auth: { username: "test-only-user", password: "test-only-password" },
};
const importOptions = {
    xml: '<robot><suite name="Native"/></robot>',
    project: "isolated", launch: "Service: Native", description: "Isolated import",
    attributes: [{ key: "dialect", value: "swagger2" }], mode: "DEBUG" as const,
};
const operations = [
    { name: "import", suffix: "/plugin/isolated/RobotFramework/import", method: "POST",
        run: (instance: ReportPortalClient) => instance.importLaunch(importOptions) },
    { name: "launch", suffix: "/isolated/launch/42", method: "GET",
        run: (instance: ReportPortalClient) => instance.getLaunchById({ project: "isolated", launchId: 42 }) },
    { name: "clusters", suffix: "/isolated/launch/cluster/42", method: "GET",
        run: (instance: ReportPortalClient) => instance.getLaunchClusters({ project: "isolated", launchId: 42 }) },
];

beforeAll(async () => {
    const env = jest.replaceProperty(process, "env", {
        ...process.env,
        REPORTPORTAL_ENDPOINT: "https://reportportal.example.invalid/api/v1/",
        REPORTPORTAL_API_KEY: "test-only-api-key",
    });
    try {
        const reportportal = await import("@/clients/reportportal");
        Client = reportportal.ReportPortalClient;
        sharedClient = reportportal.reportPortalClient;
    } finally {
        env.restore();
    }
});

beforeEach(() => {
    const env = jest.replaceProperty(process, "env", {
        ...process.env,
        REPORTPORTAL_ENDPOINT: "https://reportportal.example.invalid/api/v1/",
        REPORTPORTAL_API_KEY: "test-only-api-key",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "",
        http_proxy: "", https_proxy: "", all_proxy: "", no_proxy: "",
    });
    restoreEnvironment = () => env.restore();
    client = new Client();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected direct request"));
    jest.spyOn(axios, "request").mockRejectedValue(new Error("Unexpected Axios request"));
});

afterEach(() => {
    jest.restoreAllMocks();
    restoreEnvironment();
});

test.each(operations)("$name uses Axios without overriding environment proxy discovery", async ({ run, suffix, method, name }) => {
    jest.mocked(axios.request).mockResolvedValue({ status: 200, data: '{"id":42}' });
    await expect(run(client)).resolves.toEqual(name === "import" ? '{"id":42}' : { id: 42 });
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
        url: `https://reportportal.example.invalid/api/v1${suffix}`, method, proxy: undefined,
        timeout: method === "POST" ? 120000 : 15000,
    }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(["http", "https"])("%s proxy is scoped to the client for all ReportPortal operations", async (protocol) => {
    const before = { ...process.env };
    const configuration = { ...proxy, protocol };
    const proxied = new Client({ proxy: configuration });
    jest.mocked(axios.request).mockResolvedValue({ status: 200, data: '{"id":42}' });
    for (const { run, suffix, method, name } of operations) {
        await expect(run(proxied)).resolves.toEqual(name === "import" ? '{"id":42}' : { id: 42 });
        expect(axios.request).toHaveBeenLastCalledWith(expect.objectContaining({
            url: `https://reportportal.example.invalid/api/v1${suffix}`,
            method, proxy: configuration, timeout: method === "POST" ? 120000 : 15000, maxRedirects: 0,
            responseType: "text",
        }));
        const config = jest.mocked(axios.request).mock.calls.at(-1)?.[0];
        expect(config?.httpsAgent.options.rejectUnauthorized).toBe(true);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(process.env).toEqual(before);
    await client.getLaunchById({ project: "isolated", launchId: 42 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(axios.request).toHaveBeenCalledTimes(4);
    expect(jest.mocked(axios.request).mock.calls[3][0].proxy).toBeUndefined();
});

test("proxied imports retain the exact XML ZIP, metadata and separate API authorization", async () => {
    jest.mocked(axios.request).mockResolvedValue({ status: 202, data: '{"id":"imported"}' });
    await expect(new Client({ proxy }).importLaunch(importOptions)).resolves.toBe('{"id":"imported"}');
    const config = jest.mocked(axios.request).mock.calls[0][0];
    expect(config.headers).toEqual(expect.objectContaining({
        authorization: expect.stringContaining("test-only-api-key"),
    }));
    if (!(config.data instanceof FormData)) throw new Error("Expected multipart form data");
    const form = config.data;
    const file = form.get("file");
    const metadata = form.get("launchImportRq");
    if (!(file instanceof Blob) || !(metadata instanceof Blob)) throw new Error("Missing multipart files");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    expect(await zip.file("lint-report.xml")?.async("string")).toBe(importOptions.xml);
    expect(JSON.parse(await metadata.text())).toEqual({
        name: importOptions.launch, description: importOptions.description,
        attributes: importOptions.attributes, mode: "DEBUG",
    });
});

test.each(operations)("$name fails explicitly without direct fallback when its proxy is unavailable", async ({ run }) => {
    jest.mocked(axios.request).mockRejectedValue(Object.assign(new Error("TEST_PRIVATE_MESSAGE"), {
        isAxiosError: true, code: "ECONNREFUSED", config: { proxy },
    }));
    await expect(run(new Client({ proxy }))).rejects.toThrow(/^Failed to request ReportPortal: ECONNREFUSED$/);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(["TEST_PRIVATE_CODE\nSECRET", undefined])("unsafe transport error codes are not exposed: %s", async (code) => {
    jest.mocked(axios.request).mockRejectedValue(Object.assign(new Error("TEST_PRIVATE_MESSAGE"), {
        isAxiosError: true, code, config: { proxy },
    }));
    await expect(new Client({ proxy }).getLaunchById({ project: "isolated", launchId: 42 }))
        .rejects.toThrow(/^Failed to request ReportPortal: REQUEST_FAILED$/);
});

test.each([301, 302, 401, 403, 407, 500])("proxy HTTP %s does not leak response bodies or retry directly", async (status) => {
    jest.mocked(axios.request).mockResolvedValue({ status, data: "TEST_PRIVATE_RESPONSE" });
    await expect(new Client({ proxy }).getLaunchClusters({ project: "isolated", launchId: 42 }))
        .rejects.toThrow(new RegExp(`^ReportPortal responded with status ${status}$`));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(axios.request).toHaveBeenCalledTimes(1);
});

test.each(operations.slice(1))("$name preserves non-JSON lookup responses", async ({ run }) => {
    jest.mocked(axios.request).mockResolvedValue({ status: 200, data: "Accepted" });
    await expect(run(new Client({ proxy }))).resolves.toBe("Accepted");
});

test("an unexpected transport response is an error, not a successful lookup", async () => {
    jest.mocked(axios.request).mockResolvedValue({ status: 200, data: { id: 42 } });
    await expect(new Client({ proxy }).getLaunchById({ project: "isolated", launchId: 42 }))
        .rejects.toThrow("Unsupported response from ReportPortal");
});

test("HTTP failures without an explicit proxy also omit private response bodies", async () => {
    jest.mocked(axios.request).mockResolvedValue({ status: 400, data: "TEST_PRIVATE_RESPONSE" });
    await expect(client.getLaunchById({ project: "isolated", launchId: 42 }))
        .rejects.toThrow(/^ReportPortal responded with status 400$/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("endpoint and API key remain required", () => {
    delete process.env.REPORTPORTAL_API_KEY;
    expect(() => new Client({ proxy })).toThrow("Missing REPORTPORTAL_ENDPOINT or REPORTPORTAL_API_KEY");
});

test.each(["explicit", "HTTP_PROXY", "HTTP_PROXY without auth"])("real %s sends all operations and intact multipart data only to the owned HTTP proxy", async (configuration) => {
    jest.mocked(axios.request).mockRestore();
    process.env.REPORTPORTAL_ENDPOINT = "http://reportportal.example.invalid/api/v1/";
    const requests: { url?: string; method?: string; authorization?: string; proxyAuthorization?: string;
        contentType?: string; body: Buffer }[] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            requests.push({
                url: request.url, method: request.method, authorization: request.headers.authorization,
                proxyAuthorization: request.headers["proxy-authorization"]?.toString(),
                contentType: request.headers["content-type"], body: Buffer.concat(chunks),
            });
            response.setHeader("Content-Type", "application/json");
            response.end('{"id":42}');
        });
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback server address");
        const proxyUrl = new URL(`http://127.0.0.1:${address.port}`);
        if (configuration !== "HTTP_PROXY without auth") {
            proxyUrl.username = "test-only-user";
            proxyUrl.password = "test-only-password";
        }
        process.env.HTTP_PROXY = configuration === "explicit" ? "http://127.0.0.1:1" : proxyUrl.href;
        const proxied = configuration === "explicit"
            ? new Client({ proxy: { ...proxy, port: address.port } })
            : new Client();
        for (const { run, name } of operations) {
            await expect(run(proxied)).resolves.toEqual(name === "import" ? '{"id":42}' : { id: 42 });
        }
        expect(requests.map(({ url, method }) => ({ url, method }))).toEqual(operations.map(({ suffix, method }) => ({
            url: `http://reportportal.example.invalid/api/v1${suffix}`, method,
        })));
        for (const request of requests) {
            expect(request.authorization).toContain("test-only-api-key");
            expect(request.proxyAuthorization).toBe(configuration === "HTTP_PROXY without auth"
                ? undefined : `Basic ${Buffer.from("test-only-user:test-only-password").toString("base64")}`);
        }
        const upload = requests[0];
        if (!upload.contentType) throw new Error("Missing multipart content type");
        const form = await new Request("http://127.0.0.1/upload", {
            method: "POST", headers: { "Content-Type": upload.contentType },
            body: new Uint8Array(upload.body),
        }).formData();
        const file = form.get("file");
        const metadata = form.get("launchImportRq");
        if (!(file instanceof Blob) || !(metadata instanceof Blob)) throw new Error("Missing multipart files");
        expect(await (await JSZip.loadAsync(await file.arrayBuffer())).file("lint-report.xml")?.async("string"))
            .toBe(importOptions.xml);
        expect(JSON.parse(await metadata.text())).toEqual(expect.objectContaining({ name: importOptions.launch }));
        expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test.each([false, true])("direct requests succeed with NO_PROXY bypass enabled: %s", async (bypass) => {
    jest.mocked(axios.request).mockRestore();
    const requests: { method?: string; url?: string; proxyAuthorization?: string }[] = [];
    const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            requests.push({
                method: request.method, url: request.url,
                proxyAuthorization: request.headers["proxy-authorization"]?.toString(),
            });
            response.setHeader("Content-Type", "application/json");
            response.end('{"id":42}');
        });
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback server address");
        process.env.REPORTPORTAL_ENDPOINT = `http://127.0.0.1:${address.port}/api/v1`;
        process.env.HTTP_PROXY = bypass ? "http://127.0.0.1:1" : "";
        process.env.NO_PROXY = bypass ? "127.0.0.1" : "";
        const direct = new Client();
        for (const { run, name } of operations) {
            await expect(run(direct)).resolves.toEqual(name === "import" ? '{"id":42}' : { id: 42 });
        }
        expect(requests).toEqual(operations.map(({ suffix, method }) => ({
            url: `/api/v1${suffix}`, method, proxyAuthorization: undefined,
        })));
        expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test.each(["explicit", "HTTPS_PROXY", "https_proxy"])("%s uses authenticated CONNECT and never falls back when the owned proxy rejects the tunnel", async (configuration) => {
    jest.mocked(axios.request).mockRestore();
    const tunnels: { target?: string; authorization?: string; proxyAuthorization?: string }[] = [];
    const server = createServer();
    server.on("connect", (request, socket) => {
        tunnels.push({
            target: request.url, authorization: request.headers.authorization,
            proxyAuthorization: request.headers["proxy-authorization"]?.toString(),
        });
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback server address");
        process.env.HTTP_PROXY = "http://127.0.0.1:1";
        if (configuration !== "explicit") {
            process.env[configuration] = `http://test-only-user:test-only-password@127.0.0.1:${address.port}`;
        } else {
            process.env.HTTPS_PROXY = "http://127.0.0.1:1";
        }
        const proxied = configuration === "explicit"
            ? new Client({ proxy: { ...proxy, port: address.port } })
            : sharedClient;
        for (const { run } of operations) {
            await expect(run(proxied)).rejects.toThrow(/^ReportPortal responded with status 407$/);
        }
        expect(tunnels).toHaveLength(3);
        for (const tunnel of tunnels) {
            expect(tunnel.target).toBe("reportportal.example.invalid:443");
            expect(tunnel.authorization).toBeUndefined();
            expect(tunnel.proxyAuthorization).toBe(`Basic ${Buffer.from("test-only-user:test-only-password").toString("base64")}`);
        }
        expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
