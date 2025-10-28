import { Diagnostic } from "@codemirror/lint";
import { runLinter } from "@/lib/linter/runLinter";

export function openApiLinter(selectedRules: any) {
  return async (view: any): Promise<{ diagnostics: Diagnostic[]; specTitle?: string }> => {
    const content = view.state.doc.toString();
    const { diagnostics, specTitle } = await runLinter(content, selectedRules);
    return { diagnostics, specTitle };
  };
}
