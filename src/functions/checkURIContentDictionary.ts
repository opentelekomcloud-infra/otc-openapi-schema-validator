import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import { splitPathIntoTokens, looksLikeAbbreviation, looksLikeUnknownWord, ALLOWED_ABBREVIATIONS } from "@/utils/englishWords";

export function checkURIContentDictionary(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) return diagnostics;

    const checkAbreviations = rule?.functionParams?.checkAbreviations ?? true;
    const checkDictionary = rule?.functionParams?.checkDictionary ?? true;

    const allowedAbbrevs = new Set<string>(ALLOWED_ABBREVIATIONS);

    if (Array.isArray(rule?.functionParams?.allowedAbbreviations)) {
        for (const a of rule.functionParams.allowedAbbreviations) {
            if (typeof a === "string") allowedAbbrevs.add(a.toLowerCase());
        }
    }

    for (const pathKey of Object.keys(spec.paths)) {

        const tokens = splitPathIntoTokens(pathKey);

        const suspiciousAbbrevs: string[] = [];
        const suspiciousWords: string[] = [];

        for (const rawToken of tokens) {
            const token = rawToken.toLowerCase();

            if (checkAbreviations && looksLikeAbbreviation(token, allowedAbbrevs)) {
                if (!suspiciousAbbrevs.includes(token)) {
                    suspiciousAbbrevs.push(token);
                }
            }

            if (checkDictionary && looksLikeUnknownWord(token)) {
                if (!suspiciousWords.includes(token)) {
                    suspiciousWords.push(token);
                }
            }
        }

        if (suspiciousAbbrevs.length || suspiciousWords.length) {
            const index = content.indexOf(pathKey);
            const parts: string[] = [];

            if (suspiciousAbbrevs.length) {
                parts.push(`suspicious abbreviations: ${suspiciousAbbrevs.join(", ")}`);
            }

            if (suspiciousWords.length) {
                parts.push(`unknown or non-dictionary-like words: ${suspiciousWords.join(", ")}`);
            }

            const extra = parts.join("; ");

            diagnostics.push({
                from: index >= 0 ? index : 0,
                to: index >= 0 ? index + pathKey.length : 0,
                severity: mapSeverity(rule.severity),
                message: `Path "${pathKey}" may use uncommon abbreviations or non-dictionary terms (${extra}). Please avoid unusual abbreviations and use clear, consistent nouns in URIs.`,
                source: rule.id,
            });
        }
    }

    return diagnostics;
}
