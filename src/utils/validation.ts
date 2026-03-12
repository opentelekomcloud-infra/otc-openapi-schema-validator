import { FoundExample, RuleConfig } from "@/types/example";
import {
  collectExamplePaths,
  collectRequiredSchemaPaths,
  collectSchemaPaths,
  getRequestBodySchema,
  getResponseSchemaByStatus
} from "@/utils/schema";
import { matchesAnySchemaPath, matchesRequiredPath } from "@/utils/textMatch";
import { collectOperationParameters, isPlainObject } from "@/utils/spec";

/**
 * Validates request examples against the configured request contract.
 *
 * Depending on the effective rule configuration, this validation may compare
 * request examples against:
 * - selected operation parameters (for example query/path parameters for GET),
 * - the requestBody schema,
 * - required request body fields.
 *
 * Checks performed:
 * - required operation parameters are present in parameter-style examples
 * - required request body fields are present in body-style examples
 * - no undefined fields appear in the example when strict validation is enabled
 *
 * @param operation OpenAPI operation object.
 * @param pathItem Parent path item object that may also define shared parameters.
 * @param examples Extracted request examples.
 * @param spec Full OpenAPI specification.
 * @param refCache Cache used for `$ref` resolution.
 * @param cfg Effective request validation configuration for the current method.
 * @returns List of validation problem messages.
 */
export function validateRequestExamples(
  operation: any,
  pathItem: any,
  examples: FoundExample[],
  spec: any,
  refCache: Map<string, any>,
  cfg: any
): string[] {
  const problems: string[] = [];

  const allowedParamDefs = collectOperationParameters(pathItem, operation, spec, refCache, cfg?.includeOperationParameters ?? {});
  const allowedParamNames = new Set(allowedParamDefs.map((p) => p.name));
  const requiredParamNames = new Set(allowedParamDefs.filter((p) => p.required).map((p) => p.name));

  const requestBodySchema = cfg?.includeRequestBodySchema ? getRequestBodySchema(operation, spec, refCache) : null;
  const allowedBodyPaths = requestBodySchema ? collectSchemaPaths(requestBodySchema, spec, refCache) : new Set<string>();
  const requiredBodyPaths = cfg?.requireRequiredBodyFields && requestBodySchema
    ? collectRequiredSchemaPaths(requestBodySchema, spec, refCache)
    : new Set<string>();

  for (const example of examples) {
    const value = example.value;

    // Parameter-style request example (GET query/path)
    if (allowedParamNames.size > 0 && isPlainObject(value)) {
      const exampleKeys = Object.keys(value);

      for (const reqName of requiredParamNames) {
        if (!Object.prototype.hasOwnProperty.call(value, reqName)) {
          problems.push(`Request example is missing required operation parameter '${reqName}'.`);
        }
      }

      if (cfg?.forbidUndefinedFields) {
        for (const key of exampleKeys) {
          if (!allowedParamNames.has(key) && !(requestBodySchema && matchesAnySchemaPath(key, allowedBodyPaths))) {
            problems.push(`Request example contains undefined parameter/field '${key}'.`);
          }
        }
      }
    }

    // Body-style request example
    if (requestBodySchema) {
      const examplePaths = collectExamplePaths(value);

      for (const reqPath of requiredBodyPaths) {
        if (!matchesRequiredPath(reqPath, examplePaths)) {
          problems.push(`Request example is missing required body field '${reqPath}'.`);
        }
      }

      if (cfg?.forbidUndefinedFields) {
        for (const exPath of examplePaths) {
          if (!matchesAnySchemaPath(exPath, allowedBodyPaths)) {
            problems.push(`Request example contains field '${exPath}' that is not defined in the request schema.`);
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Validates response examples against the configured response schema.
 *
 * For each selected response code, the function resolves the corresponding
 * response schema and checks that example fields are defined by that schema.
 *
 * Checks performed:
 * - response example fields must exist in the response schema
 * - validation can be disabled or relaxed via `fp.responseValidation`
 *
 * @param operation OpenAPI operation object.
 * @param examples Extracted response examples paired with their status codes.
 * @param responseCodes Response codes selected for validation.
 * @param spec Full OpenAPI specification.
 * @param refCache Cache used for `$ref` resolution.
 * @param fp Rule function parameters/configuration.
 * @returns List of validation problem messages.
 */
export function validateResponseExamples(
  operation: any,
  examples: Array<FoundExample & { statusCode: string }>,
  responseCodes: string[],
  spec: any,
  refCache: Map<string, any>,
  fp: RuleConfig
): string[] {
  const problems: string[] = [];
  const responseValidation = fp.responseValidation ?? {};

  if (responseValidation.validateAgainstResponseSchema === false && responseValidation.forbidUndefinedFields === false) {
    return problems;
  }

  const schemaCache = new Map<string, any>();
  for (const statusCode of responseCodes) {
    const schema = getResponseSchemaByStatus(operation, statusCode, spec, refCache);
    if (schema) schemaCache.set(statusCode, schema);
  }

  for (const example of examples) {
    const schema = schemaCache.get(example.statusCode);
    if (!schema) continue;

    if (responseValidation.forbidUndefinedFields !== false) {
      const allowedPaths = collectSchemaPaths(schema, spec, refCache);
      const examplePaths = collectExamplePaths(example.value);

      for (const exPath of examplePaths) {
        if (!matchesAnySchemaPath(exPath, allowedPaths)) {
          problems.push(`Response example for status '${example.statusCode}' contains field '${exPath}' that is not defined in the response schema.`);
        }
      }
    }
  }

  return problems;
}
