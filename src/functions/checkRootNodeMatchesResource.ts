import { Diagnostic } from "@codemirror/lint";
import { splitPathIntoTokens, looksLikeUnknownWord } from "@/utils/englishWords";
import { dedupeDiagnostics, pushOperationDiagnostic } from "@/utils/diagnostic";
import type { NativeOperation, NativeParameterSchema } from "@/types/openapi";
import type { ReferenceCache } from "@/lib/openapi/references";
import { namingSchemas, rootSchemaFields } from "@/utils/nativeNaming";
import { responseFor, responseStatuses } from "@/utils/nativeResponse";
import { ruleOperations, ruleRequest } from "@/utils/nativeRule";

type RootNodeConfig = {
    deriveResourceFromPath?: boolean;
    splitPathTokensUsingUtils?: boolean;
    ignorePathVersionTokens?: boolean;
    useEnglishWordValidation?: boolean;
    enforcePluralForCollections?: boolean;
    enforceSingularForSingleResource?: boolean;
    detectCollectionByMethodAndPath?: boolean;
    collectionResponseMethods?: string[];
    singleResourceRequestMethods?: string[];
    ignoreWrapperNames?: string[];
    allowedGenericCollectionWrappers?: string[];
    pluralizationMode?: string;
};

type BodyExpectation = "collection" | "single" | "skip";

/**
 * Derives the resource token from the API path.
 *
 * Uses shared path-token splitting utilities when configured and takes the last
 * meaningful token as the resource name.
 */
function deriveResourceName(path: string, cfg: RootNodeConfig): string | null {
    let tokens: string[] = [];

    if (cfg.splitPathTokensUsingUtils !== false) {
        tokens = splitPathIntoTokens(path);
    } else {
        tokens = String(path)
            .split("/")
            .filter(Boolean)
            .filter((seg) => !/^\{.*\}$/.test(seg))
            .filter((seg) => !/^v\d+(?:\.\d+)?$/i.test(seg))
            .flatMap((seg) => seg.split(/[-_]/g))
            .map((seg) => seg.toLowerCase())
            .filter(Boolean);
    }

    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    return tokens[tokens.length - 1] ?? null;
}

/**
 * Returns true if the path looks like a single-resource endpoint.
 */
function pathLooksSingleResource(path: string): boolean {
    const segments = String(path).split("/").filter(Boolean);
    if (segments.length === 0) return false;
    return /^\{.*\}$/.test(segments[segments.length - 1]);
}

/**
 * Determines the response-body expectation for the operation.
 */
function getResponseExpectation(path: string, method: string, cfg: RootNodeConfig): BodyExpectation {
    const collectionMethods = Array.isArray(cfg.collectionResponseMethods)
        ? cfg.collectionResponseMethods.map((m) => String(m).toLowerCase())
        : ["get"];

    if (!collectionMethods.includes(method)) return "skip";

    if (cfg.detectCollectionByMethodAndPath === false) {
        return cfg.enforcePluralForCollections === false ? "skip" : "collection";
    }

    if (pathLooksSingleResource(path)) {
        return cfg.enforceSingularForSingleResource === false ? "skip" : "single";
    }

    return cfg.enforcePluralForCollections === false ? "skip" : "collection";
}

/**
 * Determines the request-body expectation for the operation.
 */
function getRequestExpectation(method: string, cfg: RootNodeConfig): BodyExpectation {
    const singleMethods = Array.isArray(cfg.singleResourceRequestMethods)
        ? cfg.singleResourceRequestMethods.map((m) => String(m).toLowerCase())
        : ["post", "put", "patch"];

    if (!singleMethods.includes(method)) return "skip";
    return cfg.enforceSingularForSingleResource === false ? "skip" : "single";
}

/**
 * Builds a simple English plural form.
 */
function toPlural(word: string, mode: string): string {
    const normalized = String(word ?? "").trim().toLowerCase();
    if (!normalized) return normalized;
    if (mode !== "simpleEnglish") return `${normalized}s`;

    if (/[^aeiou]y$/.test(normalized)) return `${normalized.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/.test(normalized)) return `${normalized}es`;
    return `${normalized}s`;
}

/**
 * Builds a simple English singular form.
 */
function toSingular(word: string, mode: string): string {
    const normalized = String(word ?? "").trim().toLowerCase();
    if (!normalized) return normalized;
    if (mode !== "simpleEnglish") return normalized;

    if (/ies$/.test(normalized) && normalized.length > 3) return `${normalized.slice(0, -3)}y`;
    if (/(ches|shes|ses|xes|zes)$/.test(normalized)) return normalized.slice(0, -2);
    if (normalized.endsWith("s") && !normalized.endsWith("ss")) return normalized.slice(0, -1);
    return normalized;
}

/**
 * Extracts top-level root property names from a schema.
 */
function getRootPropertyNames(schema: NativeParameterSchema, spec: unknown, cache: ReferenceCache): string[] {
    return rootSchemaFields(schema, spec, cache).map((field) => field.name);
}

/**
 * Filters out ignorable wrapper fields.
 */
function filterRelevantRootKeys(keys: string[], cfg: RootNodeConfig): string[] {
    const ignored = new Set((cfg.ignoreWrapperNames ?? []).map((v) => String(v).toLowerCase()));
    return keys.filter((key) => !ignored.has(String(key).toLowerCase()));
}

/**
 * Returns true when the word is safe to validate strictly with singular/plural checks.
 *
 * The English-word helper is used only as a sanity filter to reduce false positives
 * for service-specific or non-dictionary resource tokens. It is not treated as the
 * source of truth for pluralization.
 */
function isEnglishWordSafeForStrictCheck(word: string, cfg: RootNodeConfig): boolean {
    if (!cfg.useEnglishWordValidation) return true;

    const normalized = String(word ?? "").trim().toLowerCase();
    if (!normalized) return false;

    return !looksLikeUnknownWord(normalized);
}

/**
 * Validates request root node naming.
 */
function validateRequestBody(
    operation: NativeOperation,
    spec: any,
    resourceName: string,
    method: string,
    cfg: RootNodeConfig,
    cache: ReferenceCache,
): string[] {
    const problems: string[] = [];
    const expectation = getRequestExpectation(method, cfg);
    if (expectation === "skip") return problems;

    const payload = ruleRequest(operation, spec, cache);
    const schema = namingSchemas(payload, spec, cache)[0];
    if (payload.kind !== "formData" && !schema) return problems;
    const names = payload.kind === "formData" ? payload.fields.map((field) => field.name)
        : schema ? getRootPropertyNames(schema, spec, cache) : [];
    const rootKeys = filterRelevantRootKeys(names, cfg);
    if (rootKeys.length === 0) return problems;

    const singular = toSingular(resourceName, String(cfg.pluralizationMode ?? "simpleEnglish"));
    if (!isEnglishWordSafeForStrictCheck(resourceName, cfg) || !isEnglishWordSafeForStrictCheck(singular, cfg)) {
        return problems;
    }
    if (rootKeys.includes(singular)) return problems;

    problems.push(`Request body root field should use singular resource name '${singular}', but found [${rootKeys.join(", ")}].`);
    return problems;
}

/**
 * Validates response root node naming.
 */
function validateResponses(
    operation: NativeOperation,
    spec: any,
    resourceName: string,
    path: string,
    method: string,
    cfg: RootNodeConfig,
    cache: ReferenceCache,
): string[] {
    const problems: string[] = [];
    const expectation = getResponseExpectation(path, method, cfg);
    if (expectation === "skip") return problems;

    const genericWrappers = new Set((cfg.allowedGenericCollectionWrappers ?? []).map((v) => String(v).toLowerCase()));
    const mode = String(cfg.pluralizationMode ?? "simpleEnglish");
    const singular = toSingular(resourceName, mode);
    const plural = toPlural(singular, mode);
    if (
        !isEnglishWordSafeForStrictCheck(resourceName, cfg) ||
        !isEnglishWordSafeForStrictCheck(singular, cfg) ||
        (expectation === "collection" && !isEnglishWordSafeForStrictCheck(plural, cfg))
    ) {
        return problems;
    }

    for (const code of responseStatuses(operation)) {
        if (!/^2\d\d$/.test(String(code))) continue;

        const schema = namingSchemas(responseFor(operation, code, spec, cache), spec, cache)[0];
        if (!schema) continue;

        const rootKeys = filterRelevantRootKeys(getRootPropertyNames(schema, spec, cache), cfg);
        if (rootKeys.length === 0) continue;

        const rootKeySet = new Set(rootKeys.map((k) => String(k).toLowerCase()));

        if (expectation === "collection") {
            if (rootKeySet.has(plural) || rootKeys.some((k) => genericWrappers.has(String(k).toLowerCase()))) {
                continue;
            }

            problems.push(`Response body for status '${code}' should use plural resource name '${plural}' or one of the allowed generic wrappers [${Array.from(genericWrappers).join(", ")}], but found [${rootKeys.join(", ")}].`);
            continue;
        }

        if (expectation === "single") {
            if (rootKeySet.has(singular)) continue;

            problems.push(`Response body for status '${code}' should use singular resource name '${singular}', but found [${rootKeys.join(", ")}].`);
        }
    }

    return problems;
}

/**
 * ARG-060-01-2507-2507-O
 * Root Body Parameter Should Match Resource Type.
 *
 * Checks that top-level request and response body field names align with the
 * resource derived from the path. Collection responses should use plural names,
 * while single-resource request/response bodies should use singular names.
 */
export function checkRootNodeMatchesResource(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    if (!spec?.paths) {
        return diagnostics;
    }

    const cfg = (rule?.call?.functionParams ?? {}) as RootNodeConfig;
    const operations = ruleOperations(spec, {});
    const cache = new Map<string, unknown>();

    for (const op of operations) {
        const { path, method } = op;
        const resourceName = cfg.deriveResourceFromPath === false ? null : deriveResourceName(path, cfg);
        if (!resourceName) continue;

        const problems = [
            ...validateRequestBody(op, spec, resourceName, method, cfg, cache),
            ...validateResponses(op, spec, resourceName, path, method, cfg, cache),
        ];

        for (const problem of problems) {
            pushOperationDiagnostic(diagnostics, content, path, method, rule, problem);
        }
    }

    return dedupeDiagnostics(diagnostics);
}
