import { Diagnostic } from "@codemirror/lint";

export function checkTimeZoneFormat(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!content) return diagnostics;

    if (!rule) return diagnostics;

    if (!spec?.paths) return diagnostics;

    return diagnostics;
}
