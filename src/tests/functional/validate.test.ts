import fs from "node:fs/promises";
import path from "node:path";
/**
 * Functional/integration tests that hit a running Next.js server.
 *
 * Manual run:
 *  1) ENABLE_AUTH=false next dev -p 3000
 *  2) npm run test:functional
 *
 * Optional override:
 *  BASE_URL=http://localhost:3000 npm run test:functional
 */

describe("/api/validate (functional, http)", () => {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";

  // Allow overriding the endpoint path (some setups expose a rewrite to `/validate`)
  const validatePath = process.env.VALIDATE_PATH || "/api/validate";
  const rpProject = "openapi";

  // Enable export mode only when explicitly requested (e.g. manual run)
  const enableExport = process.env.RUN_EXPORT === "true";

  async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function waitForServer(url: string, timeoutMs = 20_000) {
    const start = Date.now();
    let lastErr: unknown;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url, { method: "GET" });
        await res.text().catch(() => undefined);
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    console.error("Server did not become ready", lastErr);
    throw new Error(`Server not ready at ${url}`);
  }

  async function verifyLaunchExistsViaInternalApi(launchId: string) {
    const url = `${baseUrl}/api/reportportal?project=${encodeURIComponent(rpProject)}&launchId=${encodeURIComponent(launchId)}`;
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const ct = res.headers.get("content-type") || "";
      const text = await res.text().catch(() => "");
      throw new Error(
        `Internal ReportPortal lookup failed for launchId=${launchId}. Status=${res.status} content-type="${ct}". Body (first 500 chars):\n` +
          text.slice(0, 500)
      );
    }

    // Some implementations may return JSON; accept non-JSON too as long as it's 2xx.
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const json = await res.json();
      // If the internal API returns a structured response, try to sanity-check it.
      if (json && typeof json === "object" && "error" in json) {
        throw new Error(
          `Internal ReportPortal lookup returned error for launchId=${launchId}: ${(json as any).error}`
        );
      }
    } else {
      await res.text().catch(() => undefined);
    }
  }

  async function readJsonOrThrow(res: Response) {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const text = await res.text().catch(() => "");
      // Surface useful diagnostics when Next returns an HTML error page.
      throw new Error(
        `Expected JSON but got content-type="${ct}" status=${res.status}. Body (first 500 chars):\n` +
          text.slice(0, 500)
      );
    }
    return res.json();
  }

  beforeAll(async () => {
    await waitForServer(`${baseUrl}/`);
  }, 30_000);

  it("returns 400 if neither file_content nor path provided", async () => {
    const res = await fetch(`${baseUrl}${validatePath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await readJsonOrThrow(res);
    expect(json.error).toMatch(
      /Provide either\s+"file_content"\s+or\s+"path"|Provide either/i
    );
  });

  it("validates YAML spec passed as file_content and returns diagnostics + rules summary", async () => {
    const spec = `
openapi: 3.0.0
info:
  title: Demo API
  version: 1.0.0
paths: {}
`.trim();

    const res = await fetch(`${baseUrl}${validatePath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file_content: spec,
        ruleset: "default",
      }),
    });

    // If auth is accidentally enabled, you may see 401 here.
    expect([200, 401]).toContain(res.status);

    if (res.status === 401) {
      const body = await res.text();
      throw new Error(
        `Got 401 Unauthorized. Ensure ENABLE_AUTH=false for functional tests. Response: ${body}`
      );
    }

    const json = await readJsonOrThrow(res);

    expect(json).toHaveProperty("diagnostics");
    expect(Array.isArray(json.diagnostics)).toBe(true);

    expect(json).toHaveProperty("rules");
    expect(json.rules).toHaveProperty("manual");
    expect(json.rules).toHaveProperty("auto");
    expect(json.rules).toHaveProperty("manual_total");
    expect(json.rules).toHaveProperty("auto_total");
    expect(json.rules).toHaveProperty("manual_selected");
    expect(json.rules).toHaveProperty("auto_selected");

    for (const d of json.diagnostics) {
      expect(d).toHaveProperty("lineNumber");
      expect(d).toHaveProperty("severity");
    }
  });

  it("returns 405 on GET (or 404 if route missing)", async () => {
    const res = await fetch(`${baseUrl}${validatePath}`, { method: "GET" });

    if (res.status === 500) {
      // Read body for diagnostics (Next often returns HTML on 500)
      const ct = res.headers.get("content-type") || "";
      const text = await res.text().catch(() => "");
      throw new Error(
        `GET /api/validate returned 500 content-type="${ct}". Body (first 500 chars):\n` +
          text.slice(0, 500)
      );
    }

    expect([405, 404]).toContain(res.status);
  });

  it(
    "exports all YAML specs in ./specs folder to ReportPortal (5s timeout each)",
    async () => {
      // Folder is alongside this test file: src/tests/functional/specs
      const specsDir = path.join(__dirname, "specs");
      const entries = await fs.readdir(specsDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((n) => n.toLowerCase().endsWith(".yaml") || n.toLowerCase().endsWith(".yml"))
        .sort((a, b) => a.localeCompare(b));

      if (files.length === 0) {
        throw new Error(`No .yaml/.yml specs found in ${specsDir}`);
      }

      for (const filename of files) {
        const fullPath = path.join(specsDir, filename);

        const res = await fetchWithTimeout(
          `${baseUrl}${validatePath}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path: fullPath,
              ruleset: "default",
              ...(enableExport ? { export: "xml" } : {}),
            }),
          },
          5_000
        );

        if (res.status === 401) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `Spec ${filename}: got 401 Unauthorized. Ensure ENABLE_AUTH=false. Response: ${body}`
          );
        }

        if (res.status === 500) {
          const ct = res.headers.get("content-type") || "";
          const text = await res.text().catch(() => "");
          throw new Error(
            `Spec ${filename}: server returned 500 content-type="${ct}". Body (first 500 chars):\n` +
              text.slice(0, 500)
          );
        }

        if (res.status !== 200) {
          const text = await res.text().catch(() => "");
          throw new Error(`Spec ${filename}: unexpected status ${res.status}. Body: ${text.slice(0, 500)}`);
        }

        const json = await readJsonOrThrow(res);

        if (enableExport) {
          expect(json).toHaveProperty("success", true);
          expect(json).toHaveProperty("launch");
          expect(json.launch).toHaveProperty("id");

          await verifyLaunchExistsViaInternalApi(String(json.launch.id));
        } else {
          // CI mode: normal validation contract
          expect(json).toHaveProperty("diagnostics");
          expect(Array.isArray(json.diagnostics)).toBe(true);
        }
      }
    },
    120_000
  );
});
