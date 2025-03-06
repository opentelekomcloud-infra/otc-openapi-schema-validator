import { Diagnostic, linter } from "@codemirror/lint";
import yaml from "js-yaml";
import { httpsCheckServers } from "@/functions/httpsCheckServers";

const functionsMap: { [key: string]: (spec: any, content: string, rule: any) => Diagnostic[] } = {
    httpsCheckServers,
};

export function openApiLinter(selectedRules: any) {
    return (view: any): Diagnostic[] => {
        let diagnostics: Diagnostic[] = [];
        const content = view.state.doc.toString();

        try {
            const spec = yaml.load(content);
            // @ts-ignore
            Object.values(selectedRules).forEach((rules: any[]) => {
                rules.forEach(rule => {
                    if (rule.then && rule.then.function) {
                        const funcName = rule.then.function;
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