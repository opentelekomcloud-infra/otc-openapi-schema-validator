import * as yaml from 'js-yaml';
import { Diagnostic } from '@codemirror/lint';

import { checkHttpsServers } from '@/functions/checkHttpsServers';
import { checkParamElementPresence } from '@/functions/checkParamElementPresence';
import { checkContentType } from '@/functions/checkContentType';
import { checkElementSensitiveData } from '@/functions/checkElementSensitiveData';
import { checkAllowedMethods } from '@/functions/checkAllowedMethods';
import { checkOASSpec } from '@/functions/checkOASSpec';
import { checkOASVersion } from '@/functions/checkOASVersion';
import { checkCRUD } from '@/functions/checkCRUD';
import { checkSuccessResponse } from '@/functions/checkSuccessResponse';
import { checkGetIdempotency } from '@/functions/checkGetIdempotency';
import { checkGetReturnObject } from '@/functions/checkGetReturnObject';
import { checkParamElementAbsence } from '@/functions/checkParamElementAbsence';
import { checkRequestEncapsulation } from '@/functions/checkRequestEncapsulation';
import { checkResponseEncapsulation } from '@/functions/checkResponseEncapsulation';
import { checkCompatibility } from '@/functions/checkCompatibility';
import { checkURIFormat } from '@/functions/checkURIFormat';
import { checkURILength } from '@/functions/checkURILength';
import { checkURIContentDictionary } from '@/functions/checkURIContentDictionary';
import { checkURIContentSyntax } from '@/functions/checkURIContentSyntax';
import { checkURIContentSpecial } from '@/functions/checkURIContentSpecial';
import { checkURIContentUnicode } from '@/functions/checkURIContentUnicode';
import { checkURIContentComplexity } from '@/functions/checkURIContentComplexity';
import { checkURIResourceFormat } from '@/functions/checkURIResourceFormat';
import { checkInternationalization } from '@/functions/checkInternationalization';
import { checkCommonParameters } from "@/functions/checkCommonParameters";
import { checkTimeZoneFormat } from "@/functions/checkTimeZoneFormat";
import { checkTimeFieldNaming } from "@/functions/checkTimeFieldNaming";
import { checkResponseIncludesCount } from "@/functions/checkResponseIncludesCount";
import { checkQuotaApiPresence } from "@/functions/checkQuotaApiPresence";
import { checkTimeFieldsInDetailQuery } from "@/functions/checkTimeFieldsInDetailQuery";
import { checkCustomHeaders } from "@/functions/checkCustomHeaders";
import { checkResponseHeader } from "@/functions/checkResponseHeader";
import { checkDefaultLimitValue } from "@/functions/checkDefaultLimitValue";
import { checkPaginationParameters } from "@/functions/checkPaginationParameters";
import { checkURIFilterParams } from "@/functions/checkURIFilterParams";
import { checkSortingParams } from "@/functions/checkSortingParams";
import { checkBatchUsesPost } from "@/functions/checkBatchUsesPost";
import { checkBatchPayloadArrayOfObjects } from "@/functions/checkBatchPayloadArrayOfObjects";
import { checkSyncBatchResultGranularity } from "@/functions/checkSyncBatchResultGranularity";
import { checkAsyncBatchResponse } from "@/functions/checkAsyncBatchResponse";
import { checkExamplesFormat } from "@/functions/checkExamplesFormat";
import { checkVersionConvention } from "@/functions/checkVersionConvention";
import { checkIncompatibleChangeVersioning } from "@/functions/checkIncompatibleChangeVersioning";
import { checkParameterIsSnakeCase } from "@/functions/checkParameterIsSnakeCase";
import { checkProjectIdByTagScope } from "@/functions/checkProjectIdByTagScope";
import { checkNoRedundantParameters } from "@/functions/checkNoRedundantParameters";
import { checkRootNodeMatchesResource } from "@/functions/checkRootNodeMatchesResource";
import { getSource } from "@/functions/common";
import { assertRuleFunction } from "@/lib/linter/ruleCatalog";
import { objectRange, sourceLineNumber, sourceMap } from "@/lib/openapi/sourceMap";
import { NativeReferenceError, appendPointer } from "@/lib/openapi/references";
import { NativeAccessorError } from "@/lib/openapi/accessorError";
import { NativeBaselineError } from "@/lib/openapi/baselineError";
import { NativeExampleError } from "@/lib/openapi/exampleError";
import { createExecutionContext } from "@/lib/openapi/createExecutionContext";
import { bindExecutionContext, type NativeExecutionContext } from "@/lib/openapi/executionContext";

function executionRange(content: string, error: unknown, document: unknown) {
  if (error instanceof NativeBaselineError) return { from: 0, to: 0, lineNumber: 1 };
  if (error instanceof NativeReferenceError && error.sourceNode !== undefined) {
    return objectRange(document, content, error.sourceNode, "$ref", "value");
  }
  if (error instanceof NativeReferenceError || error instanceof NativeAccessorError || error instanceof NativeExampleError) {
    const pointer = error instanceof NativeReferenceError ? appendPointer(error.pointer, "$ref") : error.pointer;
    return sourceMap(content).locate(pointer, error instanceof NativeReferenceError ? "value" : "key");
  }
  return sourceMap(content).locate("#");
}

const log = {
  debug: (...args: any[]) => console.debug("[runLinter]", ...args),
};

export const functionsMap: {
  [key: string]: (spec: any, content: string, rule: any, context?: NativeExecutionContext) => Diagnostic[] | Promise<Diagnostic[]>;
} = {
  checkHttpsServers,
  checkParamElementPresence,
  checkContentType,
  checkElementSensitiveData,
  checkAllowedMethods,
  checkOASSpec,
  checkOASVersion,
  checkCRUD,
  checkSuccessResponse,
  checkGetIdempotency,
  checkGetReturnObject,
  checkParamElementAbsence,
  checkRequestEncapsulation,
  checkResponseEncapsulation,
  checkCompatibility,
  checkURIFormat,
  checkURILength,
  checkURIContentDictionary,
  checkURIContentSyntax,
  checkURIContentSpecial,
  checkURIContentUnicode,
  checkURIContentComplexity,
  checkURIResourceFormat,
  checkInternationalization,
  checkCommonParameters,
  checkTimeZoneFormat,
  checkTimeFieldNaming,
  checkResponseIncludesCount,
  checkQuotaApiPresence,
  checkTimeFieldsInDetailQuery,
  checkCustomHeaders,
  checkResponseHeader,
  checkDefaultLimitValue,
  checkPaginationParameters,
  checkURIFilterParams,
  checkSortingParams,
  checkBatchUsesPost,
  checkBatchPayloadArrayOfObjects,
  checkSyncBatchResultGranularity,
  checkAsyncBatchResponse,
  checkExamplesFormat,
  checkVersionConvention,
  checkIncompatibleChangeVersioning,
  checkParameterIsSnakeCase,
  checkProjectIdByTagScope,
  checkNoRedundantParameters,
  checkRootNodeMatchesResource
};

export interface SourceDiagnostic extends Diagnostic {
  readonly lineNumber: number;
}

/**
 * Run the OpenAPI linter for a set of selected rules.
 * This is environment-agnostic (can be called from browser or server).
 */
export async function runLinter(
  content: string,
  selectedRules: any
): Promise<{ diagnostics: SourceDiagnostic[]; specTitle?: string }> {
  let diagnostics: SourceDiagnostic[] = [];
  let specTitle: string | undefined;

  try {
    const spec = yaml.load(content, { json: true });
    specTitle = (spec as any)?.info?.title;

    if (!Array.isArray(selectedRules) || selectedRules.length === 0) {
      return { diagnostics, specTitle };
    }
    log.debug("loaded rules: ", selectedRules)
    const context = createExecutionContext(spec, content);
    const releaseContext = bindExecutionContext(context);
    try {
      const results = await Promise.all(
        selectedRules.map(async (rule: any): Promise<SourceDiagnostic[]> => {
          const funcName = rule?.call?.function;
          try {
            assertRuleFunction(rule, functionsMap);
            const ruleFunc = functionsMap[rule.call.function];
            const out = await ruleFunc(spec, content, rule, context);
            if (!Array.isArray(out)) return [];
            return out.map((diagnostic) => {
              if (!Number.isInteger(diagnostic.from) || !Number.isInteger(diagnostic.to) ||
                  diagnostic.from < 0 || diagnostic.to < diagnostic.from || diagnostic.to > content.length) {
                throw new RangeError("Rule produced a diagnostic outside the original content.");
              }
              return { ...diagnostic, lineNumber: sourceLineNumber(content, diagnostic.from) };
            });
          } catch (err: any) {
            return [
              {
                ...executionRange(content, err, spec),
                severity: 'error',
                message: `Rule "${funcName}" execution failed: ${
                  err?.message || String(err)
              }`,
                source: rule?.id ? getSource(rule) : "ruleset",
              },
            ];
          }
        })
      );

      diagnostics = results.flat();
    } finally {
      releaseContext();
    }
  } catch (error: any) {
    const position = error instanceof yaml.YAMLException ? error.mark?.position : undefined;
    const from = typeof position === "number" && position >= 0 && position <= content.length ? position : 0;
    diagnostics.push({
      from,
      to: position === undefined ? content.length : Math.min(content.length, from + 1),
      lineNumber: sourceLineNumber(content, from),
      severity: 'error',
      message: 'Specification parsing error: ' + error.message,
      source: 'parser',
    });
  }

  return { diagnostics, specTitle };
}
