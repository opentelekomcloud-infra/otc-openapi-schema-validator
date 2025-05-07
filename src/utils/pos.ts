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
