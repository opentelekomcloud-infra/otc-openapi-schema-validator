import { marked } from "marked";

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
