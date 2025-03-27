import {jsPDF} from "jspdf";
import {convertImageFromLinkToBase64, convertMarkdownToPlainText} from "@/utils/utils";
import {autoTable} from "jspdf-autotable";
import {fetchManualRulesFromAPI} from "@/components/ManualChecksSelector";
import {EditorView} from "@codemirror/view";
import React from "react";

export const exportPDF = async (diagnostics: any[], editorViewRef: React.RefObject<EditorView | null>) => {
    const doc = new jsPDF() as jsPDF & { lastAutoTable: { finalY: number } };
    const base64String = await convertImageFromLinkToBase64("/images/logo.png");
    // --- Found Issues ---
    doc.setFontSize(16);
    doc.text("Automated Compliance Validation report", 14, 40);
    const tableColumn = ["Line #", "Summary", "Severity", "Rule ID"];
    const tableRows: (string | number)[][] = [];

    diagnostics.forEach((diag) => {
        const lineNumber = editorViewRef.current
            ? editorViewRef.current.state.doc.lineAt(diag.from).number
            : "N/A";
        tableRows.push([lineNumber, diag.message, diag.severity, diag.source || ""]);
    });

    autoTable(doc,{
        willDrawPage: function (data) {
            // Header
            doc.setFontSize(20)
            doc.setTextColor(40)
            if (base64String) {
                doc.addImage(base64String as string, 'JPEG', data.settings.margin.left, 15, 15, 7)
            }
            doc.text('Open Telekom Cloud', data.settings.margin.left + 20, 21)
        },
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
    const allManualRules = await fetchManualRulesFromAPI()
    doc.setFontSize(16);
    doc.text("Manual Checklist", 14, afterLintY + 15);

    const manualTableColumn = ["ID", "Title", "Summary", "Option", "Verified"];
    const manualTableRows: (string | boolean | undefined)[][] = allManualRules.map((rule) => [
        rule.id,
        rule.title,
        convertMarkdownToPlainText(rule.message),
        rule.option,
        rule.verified
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
        // Footer
        didDrawPage: function (data) {
            const pageCount = (doc as any).internal.getNumberOfPages();
            // For each page, print the page number and the total pages
            for (let i = 1; i <= pageCount; i++) {
                doc.setFontSize(10);
                doc.setPage(i);
                const pageSize = doc.internal.pageSize;
                const pageHeight = pageSize.height ? pageSize.height : pageSize.getHeight();
                doc.text('© 2025 T-Systems International GmbH. All rights reserved.', doc.internal.pageSize.getWidth() / 2, pageHeight - 10);
                doc.text('Page ' + String(i) + ' of ' + String(pageCount), data.settings.margin.left, pageHeight - 10);
            }
        }
    });

    doc.save("lint-report.pdf");
}