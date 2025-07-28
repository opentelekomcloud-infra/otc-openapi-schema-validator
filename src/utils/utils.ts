import { marked } from "marked";
import yaml from "js-yaml";

export const convertMarkdownToPlainText = (markdown: string) => {
    const html = marked(markdown);
    const tempDiv = document.createElement("div");
    if (typeof html === "string") {
        tempDiv.innerHTML = html;
    }
    return tempDiv.textContent || tempDiv.innerText || "";
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

export async function fetchRepoMap(spec: any): Promise<Record<string, string> | null> {
    try {
        const response = await fetch('/gitea/repositories.yaml');
        const text = await response.text();

        const parsed = yaml.load(text) as { services: Record<string, string>[] };
        const serviceEntry = parsed.services.find((entry) => Object.keys(entry).includes(spec.info.title));
        return serviceEntry ?? null;
    } catch (e) {
        console.error("Failed to load repositories.yaml:", e);
        return null;
    }
}

export async function fetchSpecFromGitea(repo: string, path: string): Promise<any | null> {
    try {
        const response = await fetch(`/api/gitea?repo=${repo}&path=${path}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to fetch YAML');
        return data.yaml;
    } catch (error) {
        console.error("Failed to fetch spec YAML from gitea portal:", error);
        return null;
    }
}
