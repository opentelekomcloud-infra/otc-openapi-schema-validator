import { findMethodPositionInYaml } from "@/utils/pos";
import { mapSeverity } from "@/utils/mapSeverity";
import { Diagnostic } from "@codemirror/lint";

export function pushByPath(path: string, content: string, method: string, diagnostics: Diagnostic[], rule: any, source: string) {
  const { start, end } = findMethodPositionInYaml(content, path, method);
  diagnostics.push({
    from: start,
    to: end,
    severity: mapSeverity(rule.severity),
    message: rule.message,
    source,
  });
}
