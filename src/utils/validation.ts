import type { FoundExample, NativeExample, RuleConfig } from "@/types/example";
import type { NativeParameterSchema } from "@/types/openapi";
import { NativeExampleError } from "@/lib/openapi/exampleError";
import { collectEffectiveParameterNodes, getParameterSchema } from "@/lib/openapi/parameters";
import { hasOwnField } from "@/lib/openapi/media";
import { isRecord } from "@/lib/openapi/references";
import {
  assertJsonExample, examplePath, expectsStructuredExample, validateExampleValue, type ExampleIssue,
} from "@/lib/openapi/validateExample";
import { getRequestBodySchema, getResponseSchemaByStatus } from "@/utils/schema";

function native(example: FoundExample): example is NativeExample {
  return "scope" in example && (example.scope === "payload" || example.scope === "property");
}

function decoded(
  example: FoundExample, schema: NativeParameterSchema | undefined, spec: unknown,
  cache: Map<string, unknown>, config: RuleConfig,
): { value: unknown; problem?: never } | { problem: string; value?: never } {
  const pointer = native(example) ? example.pointer : example.source;
  const mode = config.jsonStringMode ?? "value";
  if (!["value", "serializedWhenStructured"].includes(mode)) throw new NativeExampleError(pointer, "Unsupported jsonStringMode");
  let value = example.value;
  if (mode === "serializedWhenStructured" && typeof value === "string" && expectsStructuredExample(schema, spec, cache)) {
    const media = native(example) ? example.mediaType?.split(";")[0].trim().toLowerCase() : undefined;
    const format = media ? config.formatValidation?.[media] : undefined;
    if (format !== undefined && format !== "json") throw new NativeExampleError(pointer, "Unsupported example format validator");
    const json = format === "json" || media === "application/json" || media?.endsWith("+json");
    if (json) {
      try {
        value = JSON.parse(value);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { problem: `Example contains malformed JSON at ${pointer}.` };
      }
    } else {
      return { problem: `Encoded structured example cannot be checked without a supported JSON media type at ${pointer}.` };
    }
  }
  assertJsonExample(value, pointer);
  return { value };
}

function context(message: string, example: FoundExample): string {
  return native(example) ? `${message} Example: ${example.pointer}${example.mediaType ? ` (${example.mediaType})` : ""}.` : message;
}

function issueMessage(issue: ExampleIssue, example: FoundExample, response?: string): string {
  const path = examplePath(issue.path);
  const prefix = response === undefined ? "Request example" : `Response example for status '${response}'`;
  let message: string;
  if (issue.code === "required") {
    message = response === undefined ? `${prefix} is missing required body field '${path}'.`
      : `${prefix} is missing required field '${path}'.`;
  } else if (issue.code === "undefined") {
    message = `${prefix} contains field '${path}' that is not defined in the ${response === undefined ? "request" : "response"} schema.`;
  } else {
    message = `${prefix} has an incompatible value at '${path}': ${issue.detail}`;
  }
  if (native(example) && example.scope === "property") message = `Property example: ${message}`;
  return context(message, example);
}

export function validateRequestExamples(
  operation: unknown, pathItem: unknown, examples: readonly FoundExample[], spec: unknown,
  refCache: Map<string, unknown>, cfg: RuleConfig["requestValidation"], config: RuleConfig = {},
): string[] {
  const problems: string[] = [];
  const locations = new Set(Object.entries(cfg?.includeOperationParameters ?? {}).filter(([, enabled]) => enabled).map(([location]) => location));
  const params = locations.size ? collectEffectiveParameterNodes(pathItem, operation, spec, refCache)
    .filter(({ parameter }) => locations.has(String(parameter.in))) : [];
  const names = new Set(params.map(({ parameter }) => String(parameter.name)));
  const legacySchema = cfg?.includeRequestBodySchema && examples.some((entry) => !native(entry))
    ? getRequestBodySchema(operation, spec, refCache, undefined, pathItem) : null;
  for (const example of examples) {
    const property = native(example) && example.scope === "property";
    if (property && !cfg?.includeRequestBodySchema) continue;
    if (!cfg?.includeRequestBodySchema && !params.length) continue;
    const schema = native(example) ? example.schema : legacySchema ? { node: legacySchema, pointer: "#" } : undefined;
    const result = decoded(example, schema, spec, refCache, config);
    if (result.problem !== undefined) {
      problems.push(result.problem);
      continue;
    }
    const value = result.value;
    if (!property && params.length) {
      if (!isRecord(value)) {
        problems.push(context("Request example must be an object to check operation parameters.", example));
      } else {
        for (const param of params) {
          const name = String(param.parameter.name);
          if (!hasOwnField(value, name)) {
            if (param.parameter.required === true) problems.push(context(`Request example is missing required operation parameter '${name}'.`, example));
            continue;
          }
          const parameterSchema = getParameterSchema(param.parameter, spec, refCache, param.resolvedPointer);
          if (!parameterSchema) {
            problems.push(context(`Request example cannot be checked: operation parameter '${name}' has no schema.`, example));
            continue;
          }
          for (const issue of validateExampleValue(value[name], parameterSchema, spec, refCache, {
            direction: "request", checkTypes: true, checkRequired: true, forbidUndefined: cfg?.forbidUndefinedFields === true,
          })) {
            problems.push(issueMessage({ ...issue, path: [name, ...issue.path] }, example));
          }
        }
        if (cfg?.forbidUndefinedFields && !cfg.includeRequestBodySchema) {
          for (const name of Object.keys(value)) {
            if (!names.has(name)) problems.push(context(`Request example contains undefined parameter/field '${name}'.`, example));
          }
        }
      }
    }
    if (!cfg?.includeRequestBodySchema) continue;
    if (!schema) {
      problems.push(context("Request example cannot be checked because its media has no request schema.", example));
      continue;
    }
    for (const issue of validateExampleValue(value, schema, spec, refCache, {
      direction: "request", checkTypes: true, checkRequired: cfg.requireRequiredBodyFields !== false,
      forbidUndefined: cfg.forbidUndefinedFields === true, allowedRootProperties: property ? undefined : names,
    })) problems.push(issueMessage(issue, example));
  }
  return problems;
}

export function validateResponseExamples(
  operation: unknown, examples: readonly (FoundExample & { statusCode?: string })[], responseCodes: readonly string[],
  spec: unknown, refCache: Map<string, unknown>, config: RuleConfig,
): string[] {
  const validation = config.responseValidation ?? {};
  if (validation.validateAgainstResponseSchema === false && validation.forbidUndefinedFields === false) return [];
  const problems: string[] = [];
  const legacy = new Map<string, NativeParameterSchema>();
  if (examples.some((entry) => !native(entry))) {
    for (const status of responseCodes) {
      const node = getResponseSchemaByStatus(operation, status, spec, refCache);
      if (node) legacy.set(status, { node, pointer: "#" });
    }
  }
  for (const example of examples) {
    const status = example.statusCode;
    if (status === undefined) throw new NativeExampleError(example.source, "Response example has no status");
    const schema = native(example) ? example.schema : legacy.get(status);
    if (!schema) {
      problems.push(context(`Response example for status '${status}' cannot be checked because its media has no response schema.`, example));
      continue;
    }
    const result = decoded(example, schema, spec, refCache, config);
    if (result.problem !== undefined) {
      problems.push(result.problem);
      continue;
    }
    for (const issue of validateExampleValue(result.value, schema, spec, refCache, {
      direction: "response", checkTypes: validation.validateAgainstResponseSchema !== false,
      checkRequired: validation.validateAgainstResponseSchema !== false, forbidUndefined: validation.forbidUndefinedFields !== false,
    })) problems.push(issueMessage(issue, example, status));
  }
  return problems;
}
