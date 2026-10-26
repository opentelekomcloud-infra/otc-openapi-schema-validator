import { Diagnostic } from "@codemirror/lint";
import { runPreparedLinter } from "@/lib/linter/runPreparedLinter";
import { loadAllowedAbbreviationsFromApi } from "@/utils/englishWords";

export function openApiLinter(selectedRules: any) {
  return async (view: any): Promise<{ diagnostics: Diagnostic[]; specTitle?: string }> => {
    const content = view.state.doc.toString();
    const { diagnostics, specTitle } = await runPreparedLinter(content, selectedRules, loadAllowedAbbreviationsFromApi);
    return { diagnostics, specTitle };
  };
}
