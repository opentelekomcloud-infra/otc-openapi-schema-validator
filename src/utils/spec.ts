import { AsyncResponseConfig } from "@/types/async";
import { ParamDef } from "@/types/parameter";
import { resolveRefDeep } from "@/utils/schema";
import { FoundExample, RuleConfig } from "@/types/example";

/**
 * Returns the response object for a specific HTTP status code from an OpenAPI operation.
 *
 * Supports both string and numeric keys because OpenAPI responses
 * may be defined as "202" or 202 depending on the parser.
 *
 * @param operation OpenAPI operation object
 * @param statusCode HTTP status code to retrieve
 * @returns response object or null if not present
 */
export function getResponseObjectByStatus(operation: any, statusCode: string): any | null {
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return null;
  return (responses as any)[statusCode] ?? (responses as any)[Number(statusCode)] ?? null;
}

/**
 * Checks whether an OpenAPI operation defines a response for
 * the provided HTTP status code.
 *
 * @param operation OpenAPI operation object
 * @param statusCode HTTP status code to check
 * @returns true if the response exists
 */
export function operationHasStatusCode(operation: any, statusCode: string): boolean {
  return Boolean(getResponseObjectByStatus(operation, statusCode));
}

/**
 * Determines whether an operation should be treated as asynchronous.
 *
 * The rule considers an operation asynchronous if it defines the
 * configured async success status code (default: 202).
 *
 * @param operation OpenAPI operation object
 * @param cfg Async rule configuration
 * @returns true if operation matches async response pattern
 */
export function isAsyncOperation(operation: any, cfg: AsyncResponseConfig): boolean {
  const asyncStatus = String(cfg.asyncMatch?.successStatusCode ?? "202");
  return operationHasStatusCode(operation, asyncStatus);
}


/**
 * Checks whether a value is a plain object.
 *
 * Arrays and null values are excluded.
 * This helper is used when traversing example payloads and schema-like objects.
 *
 * @param value Value to inspect.
 * @returns true if the value is a non-null object and not an array.
 */
export function isPlainObject(value: any): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


/**
 * Collects operation parameters that match the requested parameter locations.
 *
 * The function merges parameters defined at the path-item level and the operation level,
 * resolves local `$ref` parameters, filters them by the configured `in` locations,
 * and returns a deduplicated list.
 *
 * This helper is used by rules that need to compare examples or payloads against
 * query/path/header/cookie parameter definitions.
 *
 * @param pathItem OpenAPI path item object.
 * @param operation OpenAPI operation object.
 * @param spec Full OpenAPI specification.
 * @param refCache Cache used for `$ref` resolution.
 * @param includeCfg Configuration object indicating which parameter locations to include.
 * @returns Deduplicated list of collected parameter definitions.
 */
export function collectOperationParameters(
  pathItem: any,
  operation: any,
  spec: any,
  refCache: Map<string, any>,
  includeCfg: any
): ParamDef[] {
  const result: ParamDef[] = [];
  const allParams = [
    ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
  ];

  for (const rawParam of allParams) {
    const param = resolveRefDeep(rawParam, refCache, spec);
    if (!param || typeof param !== "object") continue;

    const paramIn = String((param as any).in ?? "").toLowerCase();
    if (!includeCfg?.[paramIn]) continue;

    const name = String((param as any).name ?? "");
    if (!name) continue;

    result.push({
      name,
      required: Boolean((param as any).required),
      in: paramIn,
    });
  }

  return dedupeParamDefs(result);
}

/**
 * Removes duplicate parameter definitions.
 *
 * Parameters are deduplicated by the combination of their `in` location
 * and parameter name.
 *
 * @param params Collected parameter definitions.
 * @returns Deduplicated parameter list.
 */
function dedupeParamDefs(params: ParamDef[]): ParamDef[] {
  const seen = new Map<string, ParamDef>();
  for (const p of params) {
    seen.set(`${p.in}:${p.name}`, p);
  }
  return Array.from(seen.values());
}

/**
 * Determines which response codes should be inspected for example validation.
 *
 * If explicit response codes are configured in the rule, they are used as-is.
 * Otherwise, the helper falls back to the configured selection mode:
 * - `successOnly` -> all 2xx responses
 * - any other mode -> all declared responses
 *
 * If the operation has no responses, `200` is used as a safe default.
 *
 * @param operation OpenAPI operation object.
 * @param fp Rule configuration.
 * @returns List of response codes to validate.
 */
export function getResponseCodesToCheck(operation: any, fp: RuleConfig): string[] {
  const configured = fp.responseSelection?.include;
  if (Array.isArray(configured) && configured.length > 0) return configured.map((v) => String(v));

  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return ["200"];

  const mode = String(fp.responseSelection?.mode ?? "successOnly").toLowerCase();
  if (mode === "successonly") {
    return Object.keys(responses).filter((k) => /^2\d\d$/.test(String(k)));
  }

  return Object.keys(responses).map((k) => String(k));
}

/**
 * Extracts request examples from an operation requestBody.
 *
 * Supported sources are controlled by `fp.exampleSources.request` and typically include:
 * - `content.example`
 * - `content.examples`
 *
 * @param operation OpenAPI operation object.
 * @param fp Rule configuration.
 * @returns List of extracted request examples.
 */
export function extractRequestExamples(operation: any, fp: RuleConfig): FoundExample[] {
  const rb = operation?.requestBody;
  if (!rb || typeof rb !== "object") return [];

  const contentObj = (rb as any).content;
  if (!contentObj || typeof contentObj !== "object") return [];

  const allowedSources = new Set(fp.exampleSources?.request ?? ["content.example", "content.examples"]);
  const found: FoundExample[] = [];

  for (const [mediaType, media] of Object.entries(contentObj)) {
    found.push(...extractExamplesFromMedia(media, allowedSources, `requestBody.content.${mediaType}`));
  }

  return found;
}

/**
 * Extracts response examples for the selected response codes.
 *
 * Supported example sources are controlled by `fp.exampleSources.response`.
 * Each extracted example is paired with the response status code it came from.
 *
 * @param operation OpenAPI operation object.
 * @param statusCodes Response codes selected for validation.
 * @param fp Rule configuration.
 * @returns List of extracted response examples with status code metadata.
 */
export function extractResponseExamples(operation: any, statusCodes: string[], fp: RuleConfig): Array<FoundExample & { statusCode: string }> {
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return [];

  const allowedSources = new Set(fp.exampleSources?.response ?? ["content.example", "content.examples"]);
  const found: Array<FoundExample & { statusCode: string }> = [];

  for (const statusCode of statusCodes) {
    const resp = (responses as any)[statusCode] ?? (responses as any)[Number(statusCode)];
    if (!resp || typeof resp !== "object") continue;

    const contentObj = (resp as any).content;
    if (!contentObj || typeof contentObj !== "object") continue;

    for (const [mediaType, media] of Object.entries(contentObj)) {
      const examples = extractExamplesFromMedia(media, allowedSources, `responses.${statusCode}.content.${mediaType}`);
      for (const ex of examples) {
        found.push({ ...ex, statusCode });
      }
    }
  }

  return found;
}

/**
 * Extracts examples from a single OpenAPI media-type object.
 *
 * Supports both single `example` and named `examples.*.value` entries,
 * depending on which source types are allowed.
 *
 * @param media OpenAPI media-type object.
 * @param allowedSources Allowed example source kinds.
 * @param sourcePrefix Prefix used to build a traceable example source path.
 * @returns List of extracted examples.
 */
export function extractExamplesFromMedia(media: any, allowedSources: Set<string>, sourcePrefix: string): FoundExample[] {
  const found: FoundExample[] = [];
  if (!media || typeof media !== "object") return found;

  if (allowedSources.has("content.example") && Object.prototype.hasOwnProperty.call(media, "example")) {
    found.push({ source: `${sourcePrefix}.example`, value: (media as any).example });
  }

  if (allowedSources.has("content.examples") && media.examples && typeof media.examples === "object") {
    for (const [name, ex] of Object.entries(media.examples)) {
      const value = (ex as any)?.value;
      if (value !== undefined) {
        found.push({ source: `${sourcePrefix}.examples.${name}.value`, value });
      }
    }
  }

  return found;
}
