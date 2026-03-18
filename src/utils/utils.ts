import {marked} from "marked";
import yaml from "js-yaml";

/**
 * In the browser, relative URLs are fine. In Node (API routes / server-side), `fetch` requires an absolute URL.
 * This helper builds an absolute URL when running server-side.
 */
const buildFetchUrl = (pathname: string): string => {
    const isBrowser = typeof window !== "undefined";
    if (isBrowser) return pathname;

    const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.APP_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
        "http://localhost:3000";

    return new URL(pathname, baseUrl).toString();
};

export const convertMarkdownToPlainText = (markdown: string) => {
    try {
        // Use marked to get HTML, then convert to plain text.
        const html = marked(markdown ?? "");
        // If running on the server (no DOM), strip tags and decode a few entities.
        if (typeof document === "undefined") {
            const stripped = String(html).replace(/<[^>]*>/g, "");
            return stripped
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, " ")
              .trim();
        }
        // Browser path: use a temporary DOM node to get text content.
        const tempDiv = document.createElement("div");
        if (typeof html === "string") {
            tempDiv.innerHTML = html;
        }
        const text = tempDiv.textContent || tempDiv.innerText || "";
        return text.replace(/\s+/g, " ").trim();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
        // Fallback: basic markdown stripping without DOM
        return String(markdown ?? "")
          // remove inline and fenced code
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/`[^`]*`/g, " ")
          // images ![alt](url)
          .replace(/!\[[^\]]*\]\([^\)]+\)/g, " ")
          // links [text](url) -> text
          .replace(/\[([^\]]*)\]\([^\)]+\)/g, "$1")
          // headers, formatting markers
          .replace(/^\s{0,3}#{1,6}\s+/gm, "")
          .replace(/[>*_~\-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
    }
};

export const convertImageFromLinkToBase64 = async (imageUrl: string): Promise<string> => {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

type RepoDescriptor = {
    reponame: string;
    filename?: string;
};

type RawRepoEntry = Record<string, RepoDescriptor>;

/**
 * Normalizes a single service entry from `repositories.yaml`.
 *
 * Expected raw format:
 *   - ER:
 *       reponame: enterprise-router
 *       filename: enterprise-router
 *
 * Returns only the descriptor object:
 *   { reponame, filename }
 */
function normalizeRepoEntry(entry: Record<string, unknown>): RepoDescriptor | null {
    const [title, value] = Object.entries(entry)[0] ?? [];
    if (!title || typeof value !== "object" || value == null) return null;

    const obj = value as Record<string, unknown>;
    const reponame = String(obj.reponame ?? "").trim();
    const filename = String(obj.filename ?? reponame).trim();

    if (!reponame) return null;

    return {
        reponame,
        filename: filename || reponame,
    };
}

/**
 * Accepts either:
 * - a normalized descriptor: { reponame, filename }
 * - or a raw wrapped entry: { CCE: { reponame, filename } }
 *
 * and always returns a clean descriptor.
 */
function toRepoDescriptor(repo: RepoDescriptor | RawRepoEntry | null | undefined): RepoDescriptor | null {
    if (!repo || typeof repo !== "object") return null;

    const directRepoName = String((repo as RepoDescriptor).reponame ?? "").trim();
    if (directRepoName) {
        const direct = repo as RepoDescriptor;
        return {
            reponame: directRepoName,
            filename: String(direct.filename ?? directRepoName).trim() || directRepoName,
        };
    }

    return normalizeRepoEntry(repo as Record<string, unknown>);
}

export async function fetchRepoMap(spec: any): Promise<RepoDescriptor | null> {
    const url = buildFetchUrl("/gitea/repositories.yaml");

    try {
        const response = await fetch(url);
        const text = await response.text();

        const parsed = yaml.load(text) as { services?: Record<string, unknown>[] };
        const services = Array.isArray(parsed?.services) ? parsed.services : [];
        const title = String(spec?.info?.title ?? "").trim();
        const serviceEntry = services.find((entry) => Object.prototype.hasOwnProperty.call(entry ?? {}, title));
        if (!serviceEntry) {
            console.error("Service title not found in repositories.yaml:", title);
            return null;
        }

        return normalizeRepoEntry(serviceEntry);
    } catch (e) {
        console.error("Failed to load repositories.yaml:", e);
        return null;
    }
}

export async function fetchSpecFromGitea(
    repo: RepoDescriptor | RawRepoEntry,
    path?: string,
    headers?: Record<string, string>
): Promise<any | null> {
    try {
        const descriptor = toRepoDescriptor(repo);
        if (!descriptor) {
            throw new Error("Failed to resolve repository descriptor from repositories.yaml entry");
        }

        const repoName = String(descriptor.reponame ?? "").trim();
        const fileName = String(descriptor.filename ?? descriptor.reponame).trim();
        const resolvedPath = path ?? `/openapi/${fileName}.yaml`;

        if (!repoName) {
            throw new Error("Missing repository name in RepoDescriptor");
        }
        if (!fileName && !path) {
            throw new Error("Missing filename in RepoDescriptor");
        }

        const url = buildFetchUrl(`/api/gitea?repo=${encodeURIComponent(repoName)}&path=${encodeURIComponent(resolvedPath)}`);

        const internalKey =
          typeof window === "undefined" ? process.env.ZITADEL_X_INTERNAL_API_KEY : undefined;

        const mergedHeaders: Record<string, string> = {
            ...(headers ?? {}),
            ...(internalKey ? { "x-internal-api-key": internalKey } : {}),
        };

        const response = await fetch(url, {
            headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to fetch YAML");
        return data.yaml;
    } catch (error) {
        console.error("Failed to fetch spec YAML from gitea portal:", error);
        return null;
    }
}
