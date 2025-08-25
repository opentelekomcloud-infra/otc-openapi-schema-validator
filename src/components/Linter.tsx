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
import { checkCompatibility } from "@/functions/checkCompatibility";

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
    checkCompatibility
};

export function openApiLinter(selectedRules: any) {
  return async (view: any): Promise<{ diagnostics: Diagnostic[]; specTitle?: string }> => {
    let diagnostics: Diagnostic[] = [];
    let specTitle: string | undefined = undefined;
    const content = view.state.doc.toString();

    try {
      const spec = yaml.load(content, { json: true });
      specTitle = (spec as any)?.info?.title;
      if (!Array.isArray(selectedRules) || selectedRules.length === 0) {
        return { diagnostics, specTitle }; // nothing to do
      }

      // Filter to applicable rules once, then run them in parallel against the same parsed spec/content
      const runnable = selectedRules
        .filter((rule: any) => !!rule?.call?.function && typeof functionsMap[rule.call.function] === "function");

      const results = await Promise.all(
        runnable.map(async (rule: any) => {
          const funcName = rule.call.function as string;
          const ruleFunc = functionsMap[funcName];
          try {
            const out = await ruleFunc(spec, content, rule);
            return Array.isArray(out) ? out : [];
          } catch (err: any) {
            // Isolate per-rule errors so one bad rule doesn't nuke the entire run
            return [{
              from: 0,
              to: content.length,
              severity: "error",
              message: `Rule \"${funcName}\" execution failed: ${err?.message || String(err)}`,
              source: funcName,
            } as Diagnostic];
          }
        })
      );

      diagnostics = results.flat();
    } catch (error: any) {
      diagnostics.push({
        from: 0,
        to: content.length,
        severity: "error",
        message: "Specification parsing error: " + error.message,
      });
    }

    return { diagnostics, specTitle };
  };
}
