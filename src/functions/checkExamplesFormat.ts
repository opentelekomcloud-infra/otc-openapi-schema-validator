import { Diagnostic } from "@codemirror/lint";
import { ExampleRequirement, RuleConfig } from "@/types/example";
import { dedupeDiagnostics, pushMethodDiagnostic } from "@/utils/diagnostic";
import { validateRequestExamples, validateResponseExamples } from "@/utils/validation";
import { extractRequestExamples, extractResponseExamples, getResponseCodesToCheck } from "@/utils/spec";
import { collectDocumentOperations } from "@/lib/openapi/operations";
import { appendPointer } from "@/lib/openapi/references";
import { sourceMap } from "@/lib/openapi/sourceMap";

/**
 * DOC-040-01-2507-2507-M
 * API Reference Document Sample Requirements.
 *
 * This rule validates the presence/absence of request and response examples per method,
 * and checks example consistency against the API contract.
 *
 * Supported checks:
 * - request/response examples required or forbidden per HTTP method
 * - request examples validated against requestBody schema and/or selected operation parameters
 * - mandatory request body fields present in request examples
 * - response examples validated against response schema
 * - example fields must exist in the corresponding schema/parameter definition
 */
export function checkExamplesFormat(spec: any, content: string, rule: any): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refCache = new Map<string, any>();

  if (!spec?.paths || typeof spec.paths !== "object") return diagnostics;

  const fp: RuleConfig = rule?.call?.functionParams ?? {};
  const methodsCfg = fp.methods ?? {};

  for (const { path, method, operation, pathItem, pointer, resolvedPathItemPointer } of collectDocumentOperations(spec)) {
    const methodCfg = methodsCfg[method] ?? {};
    const requestRequirement = normalizeRequirement(methodCfg.requestExample, method === "get" || method === "delete" ? "forbidden" : "optional");
    const responseRequirement = normalizeRequirement(methodCfg.responseExample, method === "delete" ? "forbidden" : "optional");
    const requestExamples = extractRequestExamples(operation, fp, spec, pathItem, refCache, {
      operation: pointer, pathItem: resolvedPathItemPointer,
    });
    const responseCodes = getResponseCodesToCheck(operation, fp);
    const responseExamples = extractResponseExamples(operation, responseCodes, fp, spec, refCache, pointer);
    const requestPayloads = requestExamples.filter((example) => example.scope === "payload");
    const responsePayloads = responseExamples.filter((example) => example.scope === "payload");
    if (requestRequirement === "required" && requestPayloads.length === 0) {
      pushMethodDiagnostic(diagnostics, content, path, method, rule, `Missing required request example.`, sourceMap(content).requestBody(path, method));
    }
    if (requestRequirement === "forbidden" && requestPayloads.length > 0) {
      pushMethodDiagnostic(diagnostics, content, path, method, rule, `Request example is not allowed for ${method.toUpperCase()} operations.`, requestPayloads[0].pointer);
    }
    if (responseRequirement === "required" && responsePayloads.length === 0) {
      pushMethodDiagnostic(diagnostics, content, path, method, rule, `Missing required response example.`, sourceMap(content).locate(appendPointer(pointer, "responses")));
    }
    if (responseRequirement === "forbidden" && responsePayloads.length > 0) {
      pushMethodDiagnostic(diagnostics, content, path, method, rule, `Response example is not allowed for ${method.toUpperCase()} operations.`, responsePayloads[0].pointer);
    }
    const requestToValidate = requestExamples.filter((example) => example.scope === "property" || requestRequirement !== "forbidden");
    const locations = new Map<string, string>();
    if (requestToValidate.length > 0) {
      const effectiveRequestValidation = mergeRequestValidation(fp.requestValidation, methodCfg.requestValidation);
      const requestProblems = validateRequestExamples(
        operation, pathItem, requestToValidate, spec, refCache, effectiveRequestValidation, fp, locations,
      );
      for (const problem of requestProblems) {
        pushMethodDiagnostic(diagnostics, content, path, method, rule, problem, locations.get(problem));
      }
    }
    const responseToValidate = responseExamples.filter((example) => example.scope === "property" || responseRequirement !== "forbidden");
    if (responseToValidate.length > 0) {
      const responseProblems = validateResponseExamples(operation, responseToValidate, responseCodes, spec, refCache, fp, locations);
      for (const problem of responseProblems) {
        pushMethodDiagnostic(diagnostics, content, path, method, rule, problem, locations.get(problem));
      }
    }
  }

  return dedupeDiagnostics(diagnostics);
}

function normalizeRequirement(value: any, fallback: ExampleRequirement): ExampleRequirement {
  const normalized = String(value ?? fallback).toLowerCase();
  if (normalized === "required" || normalized === "forbidden" || normalized === "optional") {
    return normalized;
  }
  return fallback;
}

function mergeRequestValidation(globalCfg: any, methodCfg: any): any {
  return {
    includeRequestBodySchema:
      methodCfg?.includeRequestBodySchema ?? globalCfg?.includeRequestBodySchema ?? true,
    includeOperationParameters: {
      query: methodCfg?.includeOperationParameters?.query ?? globalCfg?.includeOperationParameters?.query ?? false,
      path: methodCfg?.includeOperationParameters?.path ?? globalCfg?.includeOperationParameters?.path ?? false,
      header: methodCfg?.includeOperationParameters?.header ?? globalCfg?.includeOperationParameters?.header ?? false,
      cookie: methodCfg?.includeOperationParameters?.cookie ?? globalCfg?.includeOperationParameters?.cookie ?? false,
    },
    requireRequiredBodyFields: globalCfg?.requireRequiredBodyFields ?? true,
    forbidUndefinedFields: globalCfg?.forbidUndefinedFields ?? true,
  };
}
