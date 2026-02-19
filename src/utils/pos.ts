export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMethodPositionInYaml(content: string, path: string, method: string): { start: number; end: number } {
    const pathPattern = new RegExp(`^\\s*${escapeRegExp(path)}:\\s*$`, "m");
    const pathMatch = content.match(pathPattern);

    if (pathMatch?.index != null) {
        const afterPath = content.slice(pathMatch.index);
        const methodPattern = new RegExp(`^\\s+${method}:`, "m");
        const methodMatch = afterPath.match(methodPattern);

        if (methodMatch?.index != null) {
            const absoluteIndex = pathMatch.index + methodMatch.index + methodMatch[0].indexOf(method);
            return {
                start: absoluteIndex,
                end: absoluteIndex + method.length,
            };
        }
    }

    return { start: 0, end: content.length };
}

/**
 * Finds the position of the `parameters:` block within a given `paths -> <path> -> <method>` section.
 *
 * Returns a range that highlights the `parameters` key (not the whole block).
 * If the `parameters:` key is not present under the method, falls back to the method position.
 */
export function findMethodParametersPositionInYaml(
  content: string,
  path: string,
  method: string
): { start: number; end: number } {
  const pathPattern = new RegExp(`^\\s*${escapeRegExp(path)}:\\s*$`, "m");
  const pathMatch = content.match(pathPattern);
  if (pathMatch?.index == null) return { start: 0, end: content.length };

  const afterPath = content.slice(pathMatch.index);
  const methodPattern = new RegExp(`^\\s+${escapeRegExp(method)}:`, "m");
  const methodMatch = afterPath.match(methodPattern);
  if (methodMatch?.index == null) return { start: 0, end: content.length };

  const methodStartAbs = pathMatch.index + methodMatch.index;

  // Search for `parameters:` under this method. Best-effort YAML matching.
  const afterMethod = content.slice(methodStartAbs);
    const paramsMatch = afterMethod.match(/^\s+parameters:\s*$/m);
  if (paramsMatch?.index != null) {
    const paramsAbs = methodStartAbs + paramsMatch.index;
    const keyIdx = content.slice(paramsAbs, paramsAbs + paramsMatch[0].length).indexOf("parameters");
    const start = keyIdx >= 0 ? paramsAbs + keyIdx : paramsAbs;
    return { start, end: start + "parameters".length };
  }

  // Fallback to method position if there is no parameters block.
  return findMethodPositionInYaml(content, path, method);
}

export function findParameterPositionInYaml(content: string, path: string, method: string, paramName: string): { start: number; end: number } {
    const pathPattern = new RegExp(`^\\s*${escapeRegExp(path)}:\\s*$`, "m");
    const pathMatch = content.match(pathPattern);

    if (pathMatch?.index != null) {
        const afterPath = content.slice(pathMatch.index);
        const methodPattern = new RegExp(`^\\s+${method}:`, "m");
        const methodMatch = afterPath.match(methodPattern);

        if (methodMatch?.index != null) {
            const methodStart = pathMatch.index + methodMatch.index;
            const paramPattern = new RegExp(`\\bname:\\s*${escapeRegExp(paramName)}\\b`);
            const paramMatch = content.slice(methodStart).match(paramPattern);

            if (paramMatch?.index != null) {
                const paramStart = methodStart + paramMatch.index;
                return {
                    start: paramStart,
                    end: paramStart + paramName.length,
                };
            }
            const refPattern = new RegExp(`\\$ref:\\s*['"]?#/components/parameters/.*${escapeRegExp(paramName)}['"]?`);
            const refMatch = content.slice(methodStart).match(refPattern);

            if (refMatch?.index != null) {
                const refStart = methodStart + refMatch.index;
                return {
                    start: refStart,
                    end: refStart + refMatch[0].length,
                };
            }
        }
    }

    return { start: 0, end: content.length };
}

export function violatingIndexRange(
  content: string,
  pointer: string,
  value: string,
  forbiddenRe: RegExp,
  fallbackLen = 1
): { from: number; to: number } {
    const parts = pointer.split("/").filter(Boolean);
    if (parts.length < 2) return { from: 0, to: Math.max(0, fallbackLen) };

    let parentKey = "";
    for (let i = parts.length - 2; i >= 0; i--) {
        const p = parts[i];
        if (!/^[0-9]+$/.test(p)) {
            parentKey = p;
            break;
        }
    }
    if (!parentKey) return { from: 0, to: Math.max(0, fallbackLen) };

    // Anchor search near the violating text
    const forbiddenMatch = value.match(forbiddenRe);
    const searchToken = forbiddenMatch?.[0] ?? value;

    const anchorIdx = searchToken ? content.indexOf(searchToken) : -1;

    const yamlNeedle = `${parentKey}:`;

    if (anchorIdx >= 0) {
        const windowStart = Math.max(0, anchorIdx - 4000);
        const window = content.slice(windowStart, anchorIdx + 1);

        const lastYaml = window.lastIndexOf(`\n${yamlNeedle}`);
        const lastYamlInline = window.lastIndexOf(yamlNeedle);

        const bestPos = Math.max(lastYaml, lastYamlInline);
        if (bestPos >= 0) {
            const raw = windowStart + bestPos;

            if (window[bestPos] === "\n") {
                const afterNl = raw + 1;
                return { from: afterNl, to: afterNl + parentKey.length };
            }

            if (content[raw] === '"') {
                return { from: raw + 1, to: raw + 1 + parentKey.length };
            }
            return { from: raw, to: raw + parentKey.length };
        }
    }
    const idxYaml = content.indexOf(`\n${yamlNeedle}`);
    if (idxYaml >= 0) return { from: idxYaml + 1, to: idxYaml + 1 + parentKey.length };

    const idxYamlInline = content.indexOf(yamlNeedle);
    if (idxYamlInline >= 0) return { from: idxYamlInline, to: idxYamlInline + parentKey.length };

    return { from: 0, to: Math.max(0, fallbackLen) };
}

export function findKeyRangeInContent(content: string, key: string, searchStart?: number): { from: number; to: number } {
    const needles = [`\n${key}:`, `${key}:`];

    if (typeof searchStart === "number" && searchStart >= 0) {
        for (const n of needles) {
            const idx = content.indexOf(n, searchStart);
            if (idx >= 0) {
                const start = idx + (n.startsWith("\n") ? 1 : 0);
                return { from: start, to: start + key.length };
            }
        }
    }

    for (const n of needles) {
        const idx = content.indexOf(n);
        if (idx >= 0) {
            const start = idx + (n.startsWith("\n") ? 1 : 0);
            return { from: start, to: start + key.length };
        }
    }

    return { from: 0, to: 0 };
}
