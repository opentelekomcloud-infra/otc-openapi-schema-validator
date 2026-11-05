import {convertImageFromLinkToBase64, convertMarkdownToPlainText} from "@/utils/utils";
import {ManualRule} from "@/components/ManualChecksSelector";
import {EditorView} from "@codemirror/view";
import React from "react";
import {getSeverityLabel} from "@/utils/mapSeverity";
import { buildRobotXml } from "@/lib/export/buildRobotXml";
import { diagnosticLineNumber } from "@/lib/openapi/sourceMap";
import { diagnosticRuleId, isSkippedRule, ruleOutcomeSummary } from "@/lib/export/ruleOutcomes";

export const exportPDF = async (
  diagnostics: any[],
  selectedRules: Record<string, any>,
  manualRules: ManualRule[],
  editorViewRef: React.RefObject<EditorView | null>,
  out?: string
) => {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import("jspdf/dist/jspdf.es.min.js"),
    import("jspdf-autotable/es"),
  ]);

  const doc = new jsPDF() as any;
  const base64String = await convertImageFromLinkToBase64("/images/logo.png");
  const totalPagesExp = "{total_pages_count_string}";

  // --- Found Issues ---
  doc.setFontSize(16);
  doc.text("Automated Compliance Validation report", 14, 40);
  const { failedRuleIds, skippedRuleIds, documentFailed } = ruleOutcomeSummary(diagnostics);
  const tableColumn = ["Line #", "Summary", "Severity", "Rule ID"];
  const tableRows: (string | number)[][] = [];

  Object.values(selectedRules).forEach((rule: any) => {
    if (!failedRuleIds.has(rule.id) && !skippedRuleIds.has(rule.id)) {
      tableRows.push([documentFailed ? "Not executed" : "Passed", rule.message, rule.severity, rule.id]);
    }
  });

  diagnostics.forEach((diag) => {
    const lineNumber = diagnosticLineNumber(editorViewRef.current?.state.doc.toString(), diag);
    tableRows.push([isSkippedRule(diag) ? "Skipped" : lineNumber, diag.message,
      isSkippedRule(diag) ? "SKIP" : getSeverityLabel(diag.severity), diag.source || diagnosticRuleId(diag) || ""]);
  });

  autoTable(doc, {
    head: [tableColumn],
    body: tableRows,
    startY: 50,
    styles: { fontSize: 10, cellPadding: 3 },
    margin: { top: 30 },
    headStyles: {
      fillColor: [226, 0, 116],
      fontSize: 12,
    },
  });

  const afterLintY = doc.lastAutoTable?.finalY || 40;

  // --- Manual Rules ---
  doc.setFontSize(16);
  doc.text("Manual Checklist", 14, afterLintY + 15);

  const manualTableColumn = ["ID", "Title", "Summary", "Option", "Verified"];
  const manualTableRows = manualRules.map((rule) => [
    rule.id,
    rule.title,
    convertMarkdownToPlainText(rule.message),
    rule.option ?? "",
    rule.verified ? "Verified" : "Unverified",
  ]);
  autoTable(doc, {
    head: [manualTableColumn],
    body: manualTableRows,
    startY: afterLintY + 20,
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: {
      fillColor: [226, 0, 116],
      fontSize: 12,
    },
    willDrawPage: function (data) {
      // (Optional) Re-draw header if needed on pages for manual rules
      doc.setFontSize(20);
      doc.setTextColor(40);
      if (base64String) {
        doc.addImage(base64String as string, "JPEG", data.settings.margin.left, 15, 15, 7);
      }
      doc.text("Open Telekom Cloud", data.settings.margin.left + 20, 21);
    },
    didDrawPage: function (data) {
      doc.setFontSize(10);

      const pageSize = doc.internal.pageSize;
      const pageHeight = pageSize.height ? pageSize.height : pageSize.getHeight();
      // Footer
      doc.text(
        "© 2025 T-Systems International GmbH. All rights reserved.",
        doc.internal.pageSize.getWidth() / 2,
        pageHeight - 10,
        { align: "left" }
      );
      let str = "Page " + (doc as any).internal.getNumberOfPages();
      if (typeof doc.putTotalPages === 'function') {
        str = str + " of " + totalPagesExp;
      }
      doc.setFontSize(10);
      doc.text(str, data.settings.margin.left, pageHeight - 10);
    },
  });
  if (typeof doc.putTotalPages === 'function') {
    doc.putTotalPages(totalPagesExp);
  }
  if (!out) {
    doc.save("lint-report.pdf");
  } else {
    doc.save(out);
  }

};

export const exportRobotFramework = async (
  diagnostics: any[],
  selectedRules: Record<string, any>,
  manualRules: ManualRule[],
  editorViewRef: React.RefObject<EditorView | null>
) => {
  const content = editorViewRef.current?.state.doc.toString() ?? "";
  const robotXml = buildRobotXml(diagnostics, selectedRules, manualRules, content);
  const blob = new Blob([robotXml], { type: "application/xml" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "robot-report.xml";
  link.click();
  URL.revokeObjectURL(link.href);
};

export const exportReportPortal = async (
  diagnostics: any[],
  selectedRules: Record<string, any>,
  manualRules: ManualRule[],
  editorViewRef: React.RefObject<EditorView | null>,
  config: {
    endpoint?: string;
    apiKey?: string;
    project: string;
    launch: string;
    description?: string;
    attributes?: Array<{ key?: string; value: string }>;
    mode?: "DEFAULT" | "DEBUG";
  }
) => {
  try {
    // Build XML once, shared with server
    const content = editorViewRef?.current?.state?.doc?.toString() ?? '';
    const xml = buildRobotXml(diagnostics, selectedRules, manualRules, content);

    // Send to your Next.js proxy in JSON (not multipart)
    const res = await fetch("/api/reportportal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xml,
        project: config.project,
        launch: config.launch,
        description: config.description,
        attributes: config.attributes,
        mode: config.mode ?? "DEFAULT",
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        typeof data?.error === "string"
          ? data.error
          : `Proxy responded with status ${res.status}`;
      throw new Error(msg);
    }
  } catch (err: any) {
    console.error("ReportPortal export failed", err);
    throw err;
  }
};
