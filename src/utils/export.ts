import {jsPDF} from "jspdf";
import {convertImageFromLinkToBase64, convertMarkdownToPlainText} from "@/utils/utils";
import {autoTable} from "jspdf-autotable";
import {ManualRule} from "@/components/ManualChecksSelector";
import {EditorView} from "@codemirror/view";
import React from "react";

export const exportPDF = async (
    diagnostics: any[],
    manualRules: ManualRule[],
    editorViewRef: React.RefObject<EditorView | null>
) => {
    const doc = new jsPDF() as jsPDF & { lastAutoTable: { finalY: number } };
    const base64String = await convertImageFromLinkToBase64("/images/logo.png");
    const totalPagesExp = "{total_pages_count_string}";

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
