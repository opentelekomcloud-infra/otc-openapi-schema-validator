export function validateAllowedAbbreviations(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length ||
        !value.every((token: unknown) => typeof token === "string" && token.trim())) {
        throw new Error("Allowed abbreviations must be a non-empty array of non-empty strings.");
    }
    return Array.from(new Set(value.map((token: string) => token.trim().toLowerCase())));
}

export function parseAllowedAbbreviations(content: string): string[] {
    const quoted = Array.from(content.matchAll(/["']([^"']+)["']/g), (match) => match[1].trim()).filter(Boolean);
    const tokens = quoted.length ? quoted
        : content.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return validateAllowedAbbreviations(tokens);
}
