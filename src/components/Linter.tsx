import { Diagnostic } from "@codemirror/lint";
import yaml from "js-yaml";
import { httpsCheckServers } from "@/functions/httpsCheckServers";
import { mediaTypeCheck } from "@/functions/mediaTypeCheck";

const functionsMap: { [key: string]: (spec: any, content: string, rule: any) => Diagnostic[] } = {
    httpsCheckServers,
    mediaTypeCheck
};

export function openApiLinter(selectedRules: any) {
    return (view: any): Diagnostic[] => {
        let diagnostics: Diagnostic[] = [];
        const content = view.state.doc.toString();

        try {
            const spec = yaml.load(content);
            // @ts-expect-error err
            Object.values(selectedRules).forEach((rules: any[]) => {
                rules.forEach(rule => {
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
            });
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