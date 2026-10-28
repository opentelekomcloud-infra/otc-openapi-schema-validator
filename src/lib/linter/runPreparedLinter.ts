import { getSource } from "@/functions/common";
import { isRecord } from "@/lib/openapi/references";
import { runLinter, type SourceDiagnostic } from "./runLinter";

const dictionaryFunctions = new Set([
    "checkCommonParameters", "checkParameterIsSnakeCase", "checkRootNodeMatchesResource", "checkURIContentDictionary",
]);

function usesAbbreviations(rule: unknown): rule is Record<string, unknown> & { call: Record<string, unknown> & { function: string } } {
    if (!isRecord(rule) || !isRecord(rule.call) || typeof rule.call.function !== "string" ||
        !dictionaryFunctions.has(rule.call.function)) return false;
    const params = isRecord(rule.call.functionParams) ? rule.call.functionParams : {};
    if (rule.call.function === "checkURIContentDictionary") {
        return Boolean(params.checkAbreviations ?? true) || Boolean(params.checkDictionary ?? true);
    }
    if (rule.call.function === "checkParameterIsSnakeCase") {
        return Boolean(params.validateAllowedAbbreviations) || Boolean(params.validateTokensAgainstDictionary);
    }
    if (rule.call.function === "checkRootNodeMatchesResource") return Boolean(params.useEnglishWordValidation);
    return true;
}

export async function runPreparedLinter(
    content: string, selectedRules: unknown, loadAbbreviations: () => Promise<void>,
) {
    const rules: readonly unknown[] = Array.isArray(selectedRules) ? selectedRules : [];
    const dependentRules = rules.filter(usesAbbreviations);
    if (!dependentRules.length) return runLinter(content, selectedRules);

    try {
        await loadAbbreviations();
    } catch (error: unknown) {
        const failed = new Set<unknown>(dependentRules);
        const result = await runLinter(content, rules.filter((rule) => !failed.has(rule)));
        const diagnostics: SourceDiagnostic[] = dependentRules.map((rule) => ({
            from: 0, to: content.length, lineNumber: 1, severity: "error", source: getSource(rule),
            message: `Rule "${rule.call.function}" execution failed: unable to initialize allowed abbreviations: ${
                error instanceof Error ? error.message : String(error)}`,
        }));
        return { ...result, diagnostics: [...result.diagnostics, ...diagnostics] };
    }
    return runLinter(content, selectedRules);
}
