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
