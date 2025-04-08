import { Diagnostic } from "@codemirror/lint";
import yaml from "js-yaml";
import { httpsCheckServers } from "@/functions/httpsCheckServers";
import { mediaTypeCheck } from "@/functions/mediaTypeCheck";

const functionsMap: { [key: string]: (spec: any, content: string, rule: any) => Diagnostic[] } = {
    httpsCheckServers,
    mediaTypeCheck,
};

export function openApiLinter(selectedRules: any) {
    return (view: any): Diagnostic[] => {
        let diagnostics: Diagnostic[] = [];
        const content = view.state.doc.toString();

        try {
            const spec = yaml.load(content);

            if (Array.isArray(selectedRules) && selectedRules.length > 0) {
                selectedRules.forEach((rule: { call: { function: string } }) => {
                    if (rule.call && rule.call.function) {
                        const funcName = rule.call.function;
                        const ruleFunc = functionsMap[funcName];
                        if (typeof ruleFunc === "function") {
                            const ruleDiagnostics = ruleFunc(spec, content, rule);
                            diagnostics = diagnostics.concat(ruleDiagnostics);
                        } else {
                            console.error(`No function found for ${funcName}`);
                        }
                    }
                });
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
