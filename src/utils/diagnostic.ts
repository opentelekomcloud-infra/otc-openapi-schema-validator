import { findMethodPositionInYaml } from "@/utils/pos";
import { mapSeverity } from "@/utils/mapSeverity";
import { Diagnostic } from "@codemirror/lint";
import { getSource } from "@/functions/common";

/**
 * Pushes a diagnostic message for a specific path+method location in the YAML document.
 *
 * The function resolves the position of the HTTP method inside the OpenAPI `paths`
 * section and attaches the diagnostic to that location.
 *
 * @param path OpenAPI path string (e.g. "/v1/resources/{id}").
 * @param content Full YAML document text.
 * @param method HTTP method name (get, post, put, etc.).
 * @param diagnostics Mutable diagnostics array to append the result to.
 * @param rule Rule definition object containing severity and message.
 * @param source Diagnostic source label (usually rule identifier/title).
 */
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

/**
 * Creates a diagnostic for a rule violation bound to a specific operation
 * (`path` + `method`) and appends it to the diagnostics list.
 *
 * The message is automatically formatted to include the path and HTTP method
 * so that validation reports clearly identify the affected operation.
 *
 * @param diagnostics Mutable diagnostics array.
 * @param content Full YAML document text.
 * @param path OpenAPI path string.
 * @param method HTTP method name.
 * @param rule Rule definition containing message and severity.
 * @param details Additional contextual explanation appended to the rule message.
 */
export function pushMethodDiagnostic(
  diagnostics: Diagnostic[],
  content: string,
  path: string,
  method: string,
  rule: any,
  details: string
): void {
  const { start, end } = findMethodPositionInYaml(content, path, method);
  diagnostics.push({
    from: start,
    to: end,
    severity: mapSeverity(rule.severity),
    message: `Issue in path: "${path}" (${method.toUpperCase()}): ${rule.message} ${details}`,
    source: getSource(rule),
  });
}

/**
 * Removes duplicated diagnostics.
 *
 * Two diagnostics are considered duplicates if they share the same
 * source position (`from`/`to`), message text and rule source.
 * This prevents repeated reports when multiple validation passes
 * produce the same result.
 *
 * @param diagnostics List of diagnostics produced by validation rules.
 * @returns A new array with duplicate diagnostics removed.
 */
export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];

  for (const d of diagnostics) {
    const key = `${d.from}:${d.to}:${d.message}:${d.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(d);
  }

  return result;
}
