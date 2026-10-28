interface ExportDiagnostic {
  readonly ruleId?: unknown;
  readonly source?: unknown;
  readonly message?: unknown;
  readonly severity?: unknown;
}

export function extractRuleId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const patterns = [
    /\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+)\b/i,
    /\bRule\s+([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+)\b/i,
    /(\d+(?:\.\d+)+)\b/,
    /\bRule\s+(\d+(?:\.\d+)+)\b/i,
  ];
  let best: { value: string; index: number } | undefined;
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (match?.[1] && (best === undefined || match.index < best.index)) {
      best = { value: match[1], index: match.index };
    }
  }
  return best?.value;
}

export function diagnosticRuleId(diagnostic: ExportDiagnostic): string | undefined {
  return extractRuleId(diagnostic.ruleId) ?? extractRuleId(diagnostic.source) ??
    extractRuleId(diagnostic.message);
}

export function isDocumentError(diagnostic: ExportDiagnostic): boolean {
  return diagnostic.severity === "error" &&
    (diagnostic.source === "parser" || diagnostic.source === "version");
}

export function ruleOutcomeSummary(diagnostics: readonly ExportDiagnostic[]) {
  return {
    documentFailed: diagnostics.some(isDocumentError),
    failedRuleIds: new Set(diagnostics.filter((diagnostic) => !isDocumentError(diagnostic))
      .map(diagnosticRuleId).filter((id): id is string => id !== undefined)),
  };
}
