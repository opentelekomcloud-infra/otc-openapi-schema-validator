import { Diagnostic } from "@codemirror/lint";

export function mapSeverity(severity: string): Diagnostic["severity"] {
    switch (severity) {
        case "low":
            return "hint";
        case "medium":
            return "info";
        case "high":
            return "warning";
        case "critical":
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
            return "Medium";
        case "warning":
            return "High";
        case "error":
            return "Critical";
        default:
            return "Medium";
    }
}

export const severityToDiagnosticMap: Record<string, Diagnostic["severity"]> = {
    low: "info",
    medium: "hint",
    high: "warning",
    critical: "error",
};
