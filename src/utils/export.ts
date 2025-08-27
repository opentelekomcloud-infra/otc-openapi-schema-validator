import {jsPDF} from "jspdf";
import {convertImageFromLinkToBase64, convertMarkdownToPlainText} from "@/utils/utils";
import {autoTable} from "jspdf-autotable";
import {ManualRule} from "@/components/ManualChecksSelector";
import {EditorView} from "@codemirror/view";
import React from "react";
import {getSeverityLabel} from "@/utils/mapSeverity";

export const exportPDF = async (
    diagnostics: any[],
    selectedRules: Record<string, any>,
    manualRules: ManualRule[],
    editorViewRef: React.RefObject<EditorView | null>
) => {
    const doc = new jsPDF() as jsPDF & { lastAutoTable: { finalY: number } };
    const base64String = await convertImageFromLinkToBase64("/images/logo.png");
    const totalPagesExp = "{total_pages_count_string}";

    // --- Found Issues ---
    doc.setFontSize(16);
    doc.text("Automated Compliance Validation report", 14, 40);
    const failedRuleIds = new Set(diagnostics.map((diag) => diag.source));
    const tableColumn = ["Line #", "Summary", "Severity", "Rule ID"];
    const tableRows: (string | number)[][] = [];

    Object.values(selectedRules).forEach((rule: any) => {
        if (!failedRuleIds.has(rule.id)) {
            tableRows.push(["Passed", rule.message, rule.severity, rule.id]);
        }
    });

    diagnostics.forEach((diag) => {
        const lineNumber = editorViewRef.current
            ? editorViewRef.current.state.doc.lineAt(diag.from).number
            : "N/A";
        tableRows.push([lineNumber, diag.message, getSeverityLabel(diag.severity), diag.source || ""]);
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
        rule.option,
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

    doc.save("lint-report.pdf");
};

export const exportJUnit = async (
    diagnostics: any[],
    selectedRules: Record<string, any>,
    manualRules: ManualRule[],
    editorViewRef: React.RefObject<EditorView | null>
) => {
    // Build the diagnostic test cases.
    let diagnosticTestCases = "";
    const ts = 1;
    // Add passed rules from selectedRules that are not in diagnostics
    const failedRuleIds = new Set(diagnostics.map((diag) => diag.source));
    Object.values(selectedRules).forEach((rule: any) => {
        if (!failedRuleIds.has(rule.id)) {
            diagnosticTestCases += `<testcase classname="lint" name="Rule: ${rule.id}, Line: -1" time="${ts}" />\n`;
        }
    });
    const diagnosticsTests = Object.keys(selectedRules).length;
    diagnostics.forEach((diag) => {
        const lineNumber = editorViewRef.current
            ? editorViewRef.current.state.doc.lineAt(diag.from).number
            : "N/A";
        diagnosticTestCases += `<testcase classname="lint" name="Rule: ${diag.source || ''}, Line: ${lineNumber}" time="${ts}">`;
        diagnosticTestCases += `<failure message="Severity: ${getSeverityLabel(diag.severity)}, Rule: ${diag.source || ''}">${diag.message}</failure>`;
        diagnosticTestCases += `</testcase>\n`;
    });
    const diagnosticsFailures = diagnostics.length;

    // Build the manual rules test cases.
    let manualTestCases = "";
    manualRules.forEach((rule) => {
        manualTestCases += `<testcase classname="manual" name="${rule.id} - ${rule.title}" time="${ts}">`;
        if (!rule.verified) {
            manualTestCases += `<failure message="Manual rule not verified: ${rule.option}">${convertMarkdownToPlainText(rule.message)}</failure>`;
        }
        manualTestCases += `</testcase>\n`;
    });
    const manualTests = manualRules.length;
    const manualFailures = manualRules.filter((rule) => !rule.verified).length;

    // Construct the full XML in jUnit format.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Automated Compliance Validation Report" tests="${diagnosticsTests}" failures="${diagnosticsFailures}" time="${ts}">
    ${diagnosticTestCases}
  </testsuite>
  <testsuite name="Manual Checklist" tests="${manualTests}" failures="${manualFailures}" time="${ts}">
    ${manualTestCases}
  </testsuite>
</testsuites>`;

    const blob = new Blob([xml], { type: "application/xml" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lint-report.xml";
    link.click();
};

export type ReportPortalConfig = {
    endpoint?: string;
    apiKey?: string;
    project: string;  // e.g. "openapi"
    launch: string;   // launch name (we pass filename + ISO timestamp)
    description?: string;
    attributes?: Array<{ key?: string; value: string }>;
    mode?: 'DEFAULT' | 'DEBUG';
};

export const exportReportPortal = async (
  diagnostics: any[],
  selectedRules: Record<string, any>,
  manualRules: ManualRule[],
  editorViewRef: React.RefObject<EditorView | null>,
  config: ReportPortalConfig
) => {
    try {
        let diagnosticTestCases = "";
        const ts = 1;

        const failedRuleIds = new Set(diagnostics.map((diag) => diag.source));
        Object.values(selectedRules).forEach((rule: any) => {
            if (!failedRuleIds.has(rule.id)) {
                diagnosticTestCases += `<testcase classname="lint" name="Rule: ${rule.id}, Line: -1" time="${ts}" />\n`;
            }
        });
        const diagnosticsTests = Object.keys(selectedRules).length;

        diagnostics.forEach((diag) => {
            const lineNumber = editorViewRef.current
              ? editorViewRef.current.state.doc.lineAt(diag.from).number
              : "N/A";
            diagnosticTestCases += `<testcase classname="lint" name="Rule: ${diag.source || ''}, Line: ${lineNumber}" time="${ts}">`;
            diagnosticTestCases += `<failure message="Severity: ${getSeverityLabel(diag.severity)}, Rule: ${diag.source || ''}">${diag.message}</failure>`;
            diagnosticTestCases += `</testcase>\n`;
        });
        const diagnosticsFailures = diagnostics.length;

        let manualTestCases = "";
        manualRules.forEach((rule) => {
            manualTestCases += `<testcase classname="manual" name="${rule.id} - ${rule.title}" time="${ts}">`;
            if (!rule.verified) {
                manualTestCases += `<failure message="Manual rule not verified: ${rule.option}">${convertMarkdownToPlainText(rule.message)}</failure>`;
            }
            manualTestCases += `</testcase>\n`;
        });
        const manualTests = manualRules.length;
        const manualFailures = manualRules.filter((rule) => !rule.verified).length;

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Automated Compliance Validation Report" tests="${diagnosticsTests}" failures="${diagnosticsFailures}" time="${ts}">
    ${diagnosticTestCases}
  </testsuite>
  <testsuite name="Manual Checklist" tests="${manualTests}" failures="${manualFailures}" time="${ts}">
    ${manualTestCases}
  </testsuite>
</testsuites>`;
        // Send to Next.js proxy instead of calling ReportPortal directly from the browser
        const res = await fetch('/api/reportportal', {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data' },
          body: JSON.stringify({
            xml,
            launch: config.launch,
            description: config.description,
            attributes: config.attributes,
            mode: config.mode ?? 'DEFAULT',
            project: config.project,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = typeof data?.error === 'string' ? data.error : `Proxy responded with status ${res.status}`;
          throw new Error(msg);
        }
    } catch (err: any) {
        console.error("ReportPortal export failed", err);
        throw err
    }
};
