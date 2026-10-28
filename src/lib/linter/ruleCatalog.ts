import * as yaml from "js-yaml";

export interface CatalogRule {
    id: string;
    title: string;
    message: string;
    option?: string;
    [key: string]: unknown;
}

export interface AutoRule extends CatalogRule {
    option: string;
    severity: string;
    status: string;
    call: {
        function: string;
        functionParams?: Record<string, unknown>;
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function assertUniqueRuleIds(rules: readonly CatalogRule[]): void {
    const ids = new Set<string>();
    for (const rule of rules) {
        if (ids.has(rule.id)) throw new Error(`Duplicate rule ID "${rule.id}" in catalog.`);
        ids.add(rule.id);
    }
}

export function parseRuleFile(content: string, source: string): CatalogRule[] {
    try {
        const data: unknown = yaml.load(content);
        if (!isRecord(data) || !Array.isArray(data.rules)) {
            throw new Error('Expected an object with a "rules" array.');
        }

        const rules = data.rules.map((entry: unknown, index): CatalogRule => {
            if (!isRecord(entry)) throw new Error(`Rule at index ${index} must be an object.`);
            const { id, title, message, option } = entry;
            if (typeof id !== "string" || !id.trim()) {
                throw new Error(`Rule at index ${index} must have a non-empty string ID.`);
            }
            if (typeof title !== "string" || typeof message !== "string") {
                throw new Error(`Rule "${id}" must have a string title and message.`);
            }
            if (option !== undefined && typeof option !== "string") {
                throw new Error(`Rule "${id}" must have a string option when provided.`);
            }
            return { ...entry, id, title, message, option };
        });
        assertUniqueRuleIds(rules);
        return rules;
    } catch (error: unknown) {
        throw new Error(`Invalid rule file "${source}": ${errorMessage(error)}`);
    }
}

export async function loadRuleCatalog(
    files: readonly string[],
    readText: (file: string) => Promise<string>
): Promise<CatalogRule[]> {
    if (files.length === 0) throw new Error("No rule files found in catalog.");
    const catalogs = await Promise.all(files.map(async (file) => {
        let content: string;
        try {
            content = await readText(file);
        } catch (error: unknown) {
            throw new Error(`Unable to load rule file "${file}": ${errorMessage(error)}`);
        }
        return parseRuleFile(content, file);
    }));
    const rules = catalogs.flat();
    assertUniqueRuleIds(rules);
    return rules;
}

export function assertRuleFunction(
    rule: { id?: string; call?: unknown },
    functions: Record<string, unknown>
): asserts rule is { id?: string; call: Record<string, unknown> & { function: string } } {
    const name = isRecord(rule.call) ? rule.call.function : undefined;
    if (typeof name !== "string" || !name.trim()) {
        throw new Error(`Rule "${rule.id ?? "unknown"}" is missing call.function.`);
    }
    if (!Object.hasOwn(functions, name) || typeof functions[name] !== "function") {
        throw new Error(`Rule "${rule.id ?? "unknown"}" references unknown function "${name}".`);
    }
}

export function getImplementedRules(
    rules: readonly CatalogRule[],
    functions: Record<string, unknown>
): AutoRule[] {
    assertUniqueRuleIds(rules);
    const implemented: AutoRule[] = [];
    for (const rule of rules) {
        if (typeof rule.status !== "string" || !rule.status.trim()) {
            throw new Error(`Rule "${rule.id}" is missing status.`);
        }
        if (rule.status.toLowerCase() !== "implemented") continue;
        assertRuleFunction(rule, functions);
        if (typeof rule.option !== "string" || typeof rule.severity !== "string") {
            throw new Error(`Implemented rule "${rule.id}" must have a string option and severity.`);
        }
        const functionParams = rule.call.functionParams;
        if (functionParams !== undefined && !isRecord(functionParams)) {
            throw new Error(`Rule "${rule.id}" must have an object call.functionParams when provided.`);
        }
        implemented.push({
            ...rule,
            option: rule.option,
            severity: rule.severity,
            status: rule.status,
            call: { ...rule.call, functionParams },
        });
    }
    return implemented;
}
