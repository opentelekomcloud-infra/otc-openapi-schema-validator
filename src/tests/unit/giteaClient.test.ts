import axios from "axios";
import { createServer } from "node:http";
import type { GiteaClient } from "@/clients/gitea";

jest.mock("axios");
let Client: typeof GiteaClient;
let client: GiteaClient;
const get = jest.mocked(axios.get);

function contents(content: string) {
    return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') };
}

beforeAll(async () => {
    const env = jest.replaceProperty(process, "env", {
        ...process.env, GITEA_BASE_URL: "https://gitea.example.invalid", GITEA_TOKEN: "test-only-token",
    });
    try {
        Client = (await import("@/clients/gitea")).GiteaClient;
    } finally {
        env.restore();
    }
});
beforeEach(() => {
    jest.clearAllMocks();
    client = new Client({ baseUrl: "https://gitea.example.invalid/", token: "test-only-token" });
});

test.each([
    "\uFEFF# authored comment\r\nswagger: '2.0'\r\npaths: {}\r\n",
    '# original JSON spelling\n{"openapi":"3.0.3","paths":{}}\n',
    '# Unicode: Grüße 世界\nopenapi: 3.0.3\n',
])("raw transport preserves BOM, CRLF, comments, and spelling", async (content) => {
    get.mockResolvedValue({ status: 200, data: contents(content) });
    await expect(client.fetchRawYamlFile("native", "/openapi/spec.yaml")).resolves.toBe(content);
    expect(get).toHaveBeenCalledWith(
        "https://gitea.example.invalid/api/v1/repos/docs/native/contents/openapi/spec.yaml",
        expect.objectContaining({
            responseType: "json", timeout: 15000, maxRedirects: 0,
            headers: { Authorization: "token test-only-token", Accept: "application/json" },
        }),
    );
    expect(get.mock.calls[0][1]?.httpsAgent.options.rejectUnauthorized).toBe(true);
});

test("parsed consumers retain the native dialect and last-duplicate-key runtime values", async () => {
    get.mockResolvedValue({ status: 200, data: contents("swagger: '2.0'\nvalue: before\nvalue: after\n") });
    await expect(client.fetchYamlFile("native", "/openapi/spec.yaml"))
        .resolves.toEqual({ swagger: "2.0", value: "after" });
});

test("requested Git refs are passed as query parameters, not folded into the file path", async () => {
    get.mockResolvedValue({ status: 200, data: contents("openapi: 3.0.3\n") });
    await client.fetchRawYamlFile("native", "/openapi/spec.yaml", "feature/native");
    expect(get.mock.calls[0][1]?.params).toEqual({ ref: "feature/native" });
});

test("a scoped test proxy leaves global environment and TLS verification intact", async () => {
    const before = { ...process.env };
    const proxy = { protocol: "http", host: "proxy.example.invalid", port: 3128,
        auth: { username: "test-only-user", password: "test-only-password" } };
    client = new Client({ baseUrl: "https://gitea.example.invalid", token: "test-only-token", proxy });
    get.mockResolvedValue({ status: 200, data: contents("openapi: 3.0.3\n") });
    await client.fetchRawYamlFile("native", "openapi/spec.yaml");
    expect(get.mock.calls[0][1]?.proxy).toEqual(proxy);
    expect(get.mock.calls[0][1]?.httpsAgent.options.rejectUnauthorized).toBe(true);
    expect(process.env).toEqual(before);
});

test.each([301, 401, 403, 404, 407, 500])("HTTP %s is an explicit sanitized failure", async (status) => {
    get.mockResolvedValue({ status, data: Buffer.from("TEST_PRIVATE_RESPONSE") });
    await expect(client.fetchRawYamlFile("native", "openapi/spec.yaml"))
        .rejects.toThrow(`Failed to fetch file from Gitea: HTTP ${status}`);
});

test("transport errors cannot expose Axios configuration, credentials or response bodies", async () => {
    jest.mocked(axios.isAxiosError).mockReturnValueOnce(true);
    get.mockRejectedValueOnce(Object.assign(new Error("TEST_PRIVATE_MESSAGE"), {
        code: "ETIMEDOUT", config: { secret: "TEST_PRIVATE_CONFIG" }, response: { data: "TEST_PRIVATE_RESPONSE" },
    }));
    await expect(client.fetchRawYamlFile("native", "openapi/spec.yaml"))
        .rejects.toThrow(/^Failed to fetch file from Gitea: ETIMEDOUT$/);
});

test.each(["", " \r\n "])("empty content is an error, not a parsed success", async (content) => {
    get.mockResolvedValue({ status: 200, data: contents(content) });
    await expect(client.fetchRawYamlFile("native", "openapi/spec.yaml")).rejects.toThrow("Empty response");
});

test("invalid YAML is preserved in raw mode but reported explicitly to parsed consumers", async () => {
    const content = "openapi: [";
    get.mockResolvedValue({ status: 200, data: contents(content) });
    await expect(client.fetchRawYamlFile("native", "openapi/spec.yaml")).resolves.toBe(content);
    await expect(client.fetchYamlFile("native", "openapi/spec.yaml")).rejects.toThrow(/Invalid YAML from Gitea:.*line/);
});

test("contents responses with wrapped base64 retain the original text", async () => {
    const content = "\uFEFF# comment\r\nswagger: '2.0'\r\npaths: {}\r\n";
    const data = contents(content);
    data.content = data.content.replace(/.{1,16}/g, "$&\n");
    get.mockResolvedValue({ status: 200, data });
    await expect(client.fetchRawYamlFile("native", "spec.yaml")).resolves.toBe(content);
});

test("file path segments are encoded without changing nested paths or the requested commit", async () => {
    get.mockResolvedValue({ status: 200, data: contents("openapi: 3.0.3\n") });
    await client.fetchRawYamlFile("doc-exports", "/docs/iam5/openapi/iam v5#en.yaml",
        "a0f82c80034b8400463de4bbf269e45412484a30");
    expect(get).toHaveBeenCalledWith(
        "https://gitea.example.invalid/api/v1/repos/docs/doc-exports/contents/docs/iam5/openapi/iam%20v5%23en.yaml",
        expect.objectContaining({ params: { ref: "a0f82c80034b8400463de4bbf269e45412484a30" } }),
    );
});

test.each([
    null, [], "<html>OAuth login</html>", {},
    { type: "dir", encoding: "base64", content: "e30=" },
    { type: "file", encoding: "none", content: "e30=" },
    { type: "file", encoding: "base64" },
    { type: "file", encoding: "base64", content: 42 },
])("invalid contents envelopes fail explicitly instead of parsing login or metadata: %j", async (data) => {
    get.mockResolvedValue({ status: 200, data });
    await expect(client.fetchRawYamlFile("native", "spec.yaml")).rejects.toThrow("Unsupported contents response");
    expect(get).toHaveBeenCalledTimes(1);
});

test.each(["%%%=", "e30", "e30=garbage", "e31=", "===="])("invalid base64 is rejected: %s", async (content) => {
    get.mockResolvedValue({ status: 200, data: { type: "file", encoding: "base64", content } });
    await expect(client.fetchRawYamlFile("native", "spec.yaml")).rejects.toThrow("Invalid base64");
});

test("invalid UTF-8 bytes are not silently replaced before validation", async () => {
    get.mockResolvedValue({ status: 200, data: { type: "file", encoding: "base64", content: "/w==" } });
    await expect(client.fetchRawYamlFile("native", "spec.yaml")).rejects.toThrow("Invalid UTF-8");
});

test("real HTTP contents JSON is authenticated and decoded before raw and parsed consumers receive it", async () => {
    const actualAxios = jest.requireActual<typeof import("axios")>("axios").default;
    get.mockImplementation(actualAxios.get);
    const content = "\uFEFF# authored comment\r\nswagger: '2.0'\r\npaths: {}\r\n";
    const requests: { url?: string; authorization?: string; accept?: string }[] = [];
    const server = createServer((request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization, accept: request.headers.accept });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(contents(content)));
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected loopback server address");
        const local = new Client({
            baseUrl: "http://gitea.example.invalid", token: "test-only-token",
            proxy: { protocol: "http", host: "127.0.0.1", port: address.port },
        });
        await expect(local.fetchRawYamlFile("doc-exports", "docs/spec.yaml", "feature/native")).resolves.toBe(content);
        await expect(local.fetchYamlFile("doc-exports", "docs/spec.yaml", "feature/native"))
            .resolves.toEqual({ swagger: "2.0", paths: {} });
        expect(requests).toEqual(Array.from({ length: 2 }, () => ({
            url: "http://gitea.example.invalid/api/v1/repos/docs/doc-exports/contents/docs/spec.yaml?ref=feature%2Fnative",
            authorization: "token test-only-token", accept: "application/json",
        })));
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
