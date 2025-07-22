import { Diagnostic } from "@codemirror/lint";
import yaml from "js-yaml";
import { checkHttpsServers } from "@/functions/checkHttpsServers";
import { checkParamElementPresence } from "@/functions/checkParamElementPresence";
import { checkElementSensitiveData } from "@/functions/checkElementSensitiveData";
import { checkAllowedMethods } from "@/functions/checkAllowedMethods";
import { checkOASSpec } from "@/functions/checkOASSpec";
import { checkOASVersion } from "@/functions/checkOASVersion";
import { checkCRUD } from "@/functions/checkCRUD";
import { checkSuccessResponse } from "@/functions/checkSuccessResponse";
import { checkGetIdempotency } from "@/functions/checkGetIdempotency";
import { checkGetReturnObject } from "@/functions/checkGetReturnObject";
import { checkParamElementAbsence } from "@/functions/checkParamElementAbsence";
import { checkRequestEncapsulation } from "@/functions/checkRequestEncapsulation";
import { checkResponseEncapsulation } from "@/functions/checkResponseEncapsulation";
import { compatibilityCheckResponseStatusCode } from "@/functions/compatibilityCheckResponseStatusCode";

const functionsMap: {
  [key: string]: (spec: any, content: string, rule: any) => Diagnostic[] | Promise<Diagnostic[]>;
} = {
    checkHttpsServers,
    checkParamElementPresence,
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
    compatibilityCheckResponseStatusCode
};

export function openApiLinter(selectedRules: any) {
  return async (view: any): Promise<Diagnostic[]> => {
    let diagnostics: Diagnostic[] = [];
    const content = view.state.doc.toString();

    try {
      const spec = yaml.load(content, { json: true });
      if (Array.isArray(selectedRules) && selectedRules.length > 0) {
        for (const rule of selectedRules) {
          if (rule.call?.function) {
            const funcName = rule.call.function;
            const ruleFunc = functionsMap[funcName];
            if (typeof ruleFunc === "function") {
              const ruleDiagnostics = await Promise.resolve(ruleFunc(spec, content, rule));
              diagnostics = diagnostics.concat(ruleDiagnostics);
            } else {
              console.error(`No function found for ${funcName}`);
            }
          }
        }
      }
    } catch (error: any) {
      diagnostics.push({
        from: 0,
        to: content.length,
        severity: "error",
        message: "Specification parsing error: " + error.message,
      });
    }

    return diagnostics;
  };
}
