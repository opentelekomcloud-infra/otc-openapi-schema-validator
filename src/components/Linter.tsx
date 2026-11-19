import { Diagnostic } from "@codemirror/lint";
import { runPreparedLinter } from "@/lib/linter/runPreparedLinter";
import { loadAllowedAbbreviationsFromApi } from "@/utils/englishWords";
import type { NativeBaselineLoader } from "@/lib/openapi/executionContext";

export function openApiLinter(selectedRules: any, loadBaseline?: NativeBaselineLoader) {
  return async (view: any): Promise<{ diagnostics: Diagnostic[]; specTitle?: string }> => {
    const content = view.state.doc.toString();
    const { diagnostics, specTitle } = await runPreparedLinter(content, selectedRules, loadAllowedAbbreviationsFromApi, loadBaseline);
    return { diagnostics, specTitle };
  };
}
