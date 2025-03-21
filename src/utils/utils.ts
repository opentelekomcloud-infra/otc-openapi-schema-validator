import { marked } from "marked";

export const convertMarkdownToPlainText = (markdown: string) => {
    const html = marked(markdown);
    const tempDiv = document.createElement("div");
    if (typeof html === "string") {
        tempDiv.innerHTML = html;
    }
    return tempDiv.textContent || tempDiv.innerText || "";
};