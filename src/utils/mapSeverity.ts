import { Diagnostic } from "@codemirror/lint";

export function mapSeverity(severity: string): Diagnostic["severity"] {
    switch (severity) {
        case "info":
            return "info";
        case "low":
            return "hint";
        case "medium":
            return "warning";
        case "high":
            return "error";
        default:
            return "info"; // fallback
    }
}

// Maps CodeMirror Diagnostic severity to human-readable labels
export function getSeverityLabel(severity: string): string {
    switch (severity) {
        case "hint":
            return "Low";
        case "info":
            return "Info";
        case "warning":
            return "Medium";
        case "error":
            return "High";
        default:
            return "Info";
    }
}

export const severityToDiagnosticMap: Record<string, Diagnostic["severity"]> = {
    info: "info",
    low: "hint",
    medium: "warning",
    high: "error",
};
