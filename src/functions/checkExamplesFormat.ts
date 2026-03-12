import { Diagnostic } from "@codemirror/lint";
import { ExampleRequirement, RuleConfig } from "@/types/example";
import { dedupeDiagnostics, pushMethodDiagnostic } from "@/utils/diagnostic";
import { validateRequestExamples, validateResponseExamples } from "@/utils/validation";
import { extractRequestExamples, extractResponseExamples, getResponseCodesToCheck } from "@/utils/spec";

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

  for (const path of Object.keys(spec.paths)) {
    const pathItem = (spec.paths as any)[path];
    if (!pathItem || typeof pathItem !== "object") continue;

    const availableMethods = Object.keys(pathItem)
      .map((k) => String(k).toLowerCase())
      .filter((k) => !["parameters", "$ref", "summary", "description"].includes(k));

    for (const method of availableMethods) {
      const operation = (pathItem as any)[method];
      if (!operation || typeof operation !== "object") continue;

      const methodCfg = methodsCfg[method] ?? {};
      const requestRequirement = normalizeRequirement(methodCfg.requestExample, method === "get" || method === "delete" ? "forbidden" : "optional");
      const responseRequirement = normalizeRequirement(methodCfg.responseExample, method === "delete" ? "forbidden" : "optional");

      const requestExamples = extractRequestExamples(operation, fp);
      const responseCodes = getResponseCodesToCheck(operation, fp);
      const responseExamples = extractResponseExamples(operation, responseCodes, fp);

      // Request example presence
      if (requestRequirement === "required" && requestExamples.length === 0) {
        pushMethodDiagnostic(diagnostics, content, path, method, rule, `Missing required request example.`);
      }
      if (requestRequirement === "forbidden" && requestExamples.length > 0) {
        pushMethodDiagnostic(diagnostics, content, path, method, rule, `Request example is not allowed for ${method.toUpperCase()} operations.`);
      }

      // Response example presence
      if (responseRequirement === "required" && responseExamples.length === 0) {
        pushMethodDiagnostic(diagnostics, content, path, method, rule, `Missing required response example.`);
      }
      if (responseRequirement === "forbidden" && responseExamples.length > 0) {
        pushMethodDiagnostic(diagnostics, content, path, method, rule, `Response example is not allowed for ${method.toUpperCase()} operations.`);
      }

      // Request example validation
      if (requestExamples.length > 0 && requestRequirement !== "forbidden") {
        const effectiveRequestValidation = mergeRequestValidation(fp.requestValidation, methodCfg.requestValidation);
        const requestProblems = validateRequestExamples(
          operation,
          pathItem,
          requestExamples,
          spec,
          refCache,
          effectiveRequestValidation
        );
        for (const problem of requestProblems) {
          pushMethodDiagnostic(diagnostics, content, path, method, rule, problem);
        }
      }

      // Response example validation
      if (responseExamples.length > 0 && responseRequirement !== "forbidden") {
        const responseProblems = validateResponseExamples(operation, responseExamples, responseCodes, spec, refCache, fp);
        for (const problem of responseProblems) {
          pushMethodDiagnostic(diagnostics, content, path, method, rule, problem);
        }
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
