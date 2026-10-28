import axios from "axios";
import type { GiteaClient } from "@/clients/gitea";

jest.mock("axios");
let Client: typeof GiteaClient;
let client: GiteaClient;
const get = jest.mocked(axios.get);

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
])("raw transport preserves BOM, CRLF, comments, and spelling", async (content) => {
    get.mockResolvedValue({ status: 200, data: Buffer.from(content) });
    await expect(client.fetchRawYamlFile("native", "/openapi/spec.yaml")).resolves.toBe(content);
    expect(get).toHaveBeenCalledWith(
        "https://gitea.example.invalid/api/v1/repos/docs/native/raw/openapi/spec.yaml",
        expect.objectContaining({ responseType: "arraybuffer", timeout: 15000, maxRedirects: 0 }),
    );
    expect(get.mock.calls[0][1]?.httpsAgent.options.rejectUnauthorized).toBe(true);
});

test("parsed consumers retain the native dialect and last-duplicate-key runtime values", async () => {
    get.mockResolvedValue({ status: 200, data: Buffer.from("swagger: '2.0'\nvalue: before\nvalue: after\n") });
    await expect(client.fetchYamlFile("native", "/openapi/spec.yaml"))
        .resolves.toEqual({ swagger: "2.0", value: "after" });
});

test("requested Git refs are passed as query parameters, not folded into the file path", async () => {
    get.mockResolvedValue({ status: 200, data: Buffer.from("openapi: 3.0.3\n") });
    await client.fetchRawYamlFile("native", "/openapi/spec.yaml", "feature/native");
    expect(get.mock.calls[0][1]?.params).toEqual({ ref: "feature/native" });
});

test("a scoped test proxy leaves global environment and TLS verification intact", async () => {
    const before = { ...process.env };
    const proxy = { protocol: "http", host: "proxy.example.invalid", port: 3128,
        auth: { username: "test-only-user", password: "test-only-password" } };
    client = new Client({ baseUrl: "https://gitea.example.invalid", token: "test-only-token", proxy });
    get.mockResolvedValue({ status: 200, data: Buffer.from("openapi: 3.0.3\n") });
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
    get.mockResolvedValue({ status: 200, data: Buffer.from(content) });
    await expect(client.fetchRawYamlFile("native", "openapi/spec.yaml")).rejects.toThrow("Empty response");
});

test("invalid YAML is preserved in raw mode but reported explicitly to parsed consumers", async () => {
    const content = "openapi: [";
    get.mockResolvedValue({ status: 200, data: Buffer.from(content) });
    await expect(client.fetchRawYamlFile("native", "openapi/spec.yaml")).resolves.toBe(content);
    await expect(client.fetchYamlFile("native", "openapi/spec.yaml")).rejects.toThrow(/Invalid YAML from Gitea:.*line/);
});
