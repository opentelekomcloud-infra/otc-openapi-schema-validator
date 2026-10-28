import fs from "node:fs/promises";
import path from "node:path";
import type { AxiosProxyConfig } from "axios";
import type { GiteaClient } from "@/clients/gitea";
import { getImplementedRules, loadRuleCatalog, type AutoRule } from "@/lib/linter/ruleCatalog";
import { functionsMap, runLinter } from "@/lib/linter/runLinter";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";

jest.mock("@/utils/utils", () => ({ fetchRepoMap: jest.fn(), fetchSpecFromGitea: jest.fn() }));
const live = process.env.RUN_GITEA_PROXY_TESTS === "1" ? describe : describe.skip;

function environmentUrl(raw: string, label: string): URL {
    try {
        return new URL(raw);
    } catch {
        throw new Error(`Invalid ${label} URL`);
    }
}

function proxyConfiguration(): AxiosProxyConfig {
    const raw = process.env.GITEA_TEST_PROXY_URL;
    const username = process.env.GITEA_TEST_PROXY_USERNAME;
    const password = process.env.GITEA_TEST_PROXY_PASSWORD;
    if (!raw || !username || !password) throw new Error("Missing test proxy environment configuration");
    const url = environmentUrl(raw.includes("://") ? raw : `http://${raw}`, "test proxy");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Use an HTTP(S) proxy URL with credentials in separate environment variables");
    }
    return {
        protocol: url.protocol.slice(0, -1), host: url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), auth: { username, password },
    };
}

live("opt-in Gitea HTTPS baseline through a scoped authenticated proxy", () => {
    let client: GiteaClient;
    let rules: AutoRule[];
    let content: string;

    beforeAll(async () => {
        if (!process.env.GITEA_BASE_URL || !process.env.GITEA_TOKEN) throw new Error("Missing Gitea environment configuration");
        const base = environmentUrl(process.env.GITEA_BASE_URL, "Gitea base");
        if (base.protocol !== "https:" || base.username || base.password) throw new Error("Live Gitea tests require HTTPS without URL credentials");
        const { GiteaClient: Client } = await import("@/clients/gitea");
        client = new Client({ proxy: proxyConfiguration() });
        const files = ["Compatibility.yaml", "API_version_management.yaml"]
            .map((file) => path.join(process.cwd(), "public/rulesets/default", file));
        const catalog = await loadRuleCatalog(files, (file) => fs.readFile(file, "utf8"));
        rules = getImplementedRules(catalog, functionsMap)
            .filter((rule) => rule.id.startsWith("BAS-080-") || rule.id === "VER-030-01-2507-2507-O-5");
        content = await client.fetchRawYamlFile("enterprise-router", "openapi/enterprise-router.yaml");
    }, 30000);

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "debug").mockImplementation(() => undefined);
        jest.mocked(fetchRepoMap).mockResolvedValue({ reponame: "enterprise-router", filename: "enterprise-router" });
        jest.mocked(fetchSpecFromGitea).mockImplementation((repo) => {
            if (!("reponame" in repo) || typeof repo.reponame !== "string") throw new Error("Invalid live repository descriptor");
            return client.fetchYamlFile(repo.reponame, "openapi/enterprise-router.yaml");
        });
    });
    afterEach(() => jest.restoreAllMocks());

    test("the real raw primary input compares against the independently loaded native baseline without conversion", async () => {
        expect(rules).toHaveLength(8);
        expect(content.trim().length).toBeGreaterThan(0);
        const result = await runLinter(content, rules);
        // Do not dump vendor content or network configuration on an integration failure.
        if (result.diagnostics.length) {
            throw new Error(`Live native comparison returned ${result.diagnostics.length} diagnostics; inspect the document locally.`);
        }
        expect(fetchRepoMap).toHaveBeenCalledTimes(1);
        expect(fetchSpecFromGitea).toHaveBeenCalledTimes(1);
    }, 30000);
});
