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
  // Helpers
  const xmlEscape = (value: any) => {
    const s = String(value ?? "");
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  // Robot Framework time format: YYYYMMDD HH:MM:SS.mmm
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    const ms3 = pad(d.getMilliseconds(), 3);
    return `${y}${M}${D} ${h}:${m}:${s}.${ms3}`;
  };

  const safePath = (s: string) =>
    String(s ?? "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^\w\-\.]/g, "");
  const VROOT = "virtual:///Compliance_Validation";

  // ID helpers in Robot format
  const suiteId = (...segments: number[]) => `s${segments.join("-s")}`;
  const testId = (suiteIdStr: string, idx: number) => `${suiteIdStr}-t${idx}`;

  // Group diagnostics by source
  const grouped: Record<string, any[]> = {};
  diagnostics.forEach((diag) => {
    const key = diag?.source ? String(diag.source) : "unknown";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(diag);
  });

  const failedRuleIds = new Set(diagnostics.map((d) => d.source));
  const passedRules: any[] = Object.values(selectedRules).filter(
    (rule: any) => !failedRuleIds.has(rule.id)
  );

  // Timing model
  const CASE_MS = 200;
  const GAP_MS = 500;
  const baseMs = Date.now();

  // Root suite
  const rootName = "Compliance Validation";
  const rootId = suiteId(1);

  // Child suite IDs
  const automatedName = "Automated Compliance Validation Report";
  const automatedId = suiteId(1, 1);
  const manualName = "Manual Checklist";
  const manualId = suiteId(1, 2);

  // Build Automated subtree
  let autoInner = "";
  let autoSuiteCounter = 0;
  let autoFailTotal = 0;
  let runningMs = baseMs;

  const groupKeys = Object.keys(grouped);
  for (let gi = 0; gi < groupKeys.length; gi++) {
    const source = groupKeys[gi];
    const diags = grouped[source];
    autoSuiteCounter += 1;

    const subSuiteId = `${automatedId}-s${autoSuiteCounter}`;
    const suiteStart = runningMs;
    let testsXml = "";

    for (let ti = 0; ti < diags.length; ti++) {
      const diag = diags[ti];
      const caseStart = runningMs;
      const caseEnd = caseStart + CASE_MS;

      const v = editorViewRef.current as any;
      const docLen = v?.state?.doc?.length ?? 0;
      const within = typeof diag?.from === "number" && diag.from >= 0 && diag.from < docLen;
      const lineNumber = within ? v.state.doc.lineAt(diag.from).number : "N/A";

      const tName = `Line: ${lineNumber}`;
      const severity = xmlEscape(getSeverityLabel(diag?.severity));
      const msgText = `${severity}: ${diag?.message ?? ""}`;
      const tId = testId(subSuiteId, ti + 1);

      testsXml +=
        `      <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `        <msg timestamp="${fmt(
          caseStart
        )}" level="${
          severity === "ERROR" || severity === "CRITICAL" ? "ERROR" : "FAIL"
        }">${xmlEscape(msgText)}</msg>\n` +
        `        <status status="FAIL" starttime="${fmt(
          caseStart
        )}" endtime="${fmt(caseEnd)}"/>\n` +
        `      </test>\n`;

      autoFailTotal += 1;
      runningMs = caseEnd;
    }

    const suiteEnd = runningMs;
    autoInner +=
      `    <suite id="${subSuiteId}" name="${xmlEscape(source)}" source="${VROOT}/Automated_Compliance_Validation_Report/${safePath(source)}.robot">\n` +
      `      <status status="FAIL" starttime="${fmt(
        suiteStart
      )}" endtime="${fmt(suiteEnd)}"/>\n` +
      testsXml +
      `    </suite>\n`;

    runningMs += GAP_MS;
  }

  // Optional Passed Rules
  if (passedRules.length > 0) {
    autoSuiteCounter += 1;
    const subSuiteId = `${automatedId}-s${autoSuiteCounter}`;
    const suiteStart = runningMs;
    let testsXml = "";

    for (let i = 0; i < passedRules.length; i++) {
      const rule = passedRules[i];
      const caseStart = runningMs;
      const caseEnd = caseStart + CASE_MS;
      const tName = `Rule ${rule.id} - ${rule.title ?? rule.message ?? ""}`;
      const tId = testId(subSuiteId, i + 1);

      testsXml +=
        `      <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `        <msg timestamp="${fmt(
          caseStart
        )}" level="INFO">Passed</msg>\n` +
        `        <status status="PASS" starttime="${fmt(
          caseStart
        )}" endtime="${fmt(caseEnd)}"/>\n` +
        `      </test>\n`;

      runningMs = caseEnd;
    }

    const suiteEnd = runningMs;
    autoInner +=
      `    <suite id="${subSuiteId}" name="Passed Rules" source="${VROOT}/Automated_Compliance_Validation_Report/Passed_Rules.robot">\n` +
      `      <status status="PASS" starttime="${fmt(
        suiteStart
      )}" endtime="${fmt(suiteEnd)}"/>\n` +
      testsXml +
      `    </suite>\n`;

    runningMs += GAP_MS;
  }

  const automatedStart = baseMs;
  const automatedEnd = runningMs;
  const automatedSuiteXml =
    `  <suite id="${automatedId}" name="${xmlEscape(automatedName)}" source="${VROOT}/Automated_Compliance_Validation_Report">\n` +
    `    <status status="${
      autoFailTotal > 0 ? "FAIL" : "PASS"
    }" starttime="${fmt(automatedStart)}" endtime="${fmt(automatedEnd)}"/>\n` +
    autoInner +
    `  </suite>\n`;

  // --- Manual suite ---
  let manualInner = "";
  let manualFailTotal = 0;
  const manualStart = runningMs;

  for (let i = 0; i < manualRules.length; i++) {
    const rule = manualRules[i];
    const caseStart = runningMs;
    const caseEnd = caseStart + CASE_MS;
    const tName = `${rule.id} - ${rule.title}`;
    const isPass = !!rule?.verified;
    const rawMsg = convertMarkdownToPlainText(rule?.message ?? "");
    const tId = testId(manualId, i + 1);

    if (isPass) {
      manualInner +=
        `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `      <msg timestamp="${fmt(caseStart)}" level="INFO">Verified</msg>\n` +
        `      <status status="PASS" starttime="${fmt(
          caseStart
        )}" endtime="${fmt(caseEnd)}"/>\n` +
        `    </test>\n`;
    } else {
      manualInner +=
        `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `      <msg timestamp="${fmt(
          caseStart
        )}" level="FAIL">Manual rule not verified: ${xmlEscape(
          rule?.option ?? ""
        )} — ${xmlEscape(rawMsg)}</msg>\n` +
        `      <status status="FAIL" starttime="${fmt(
          caseStart
        )}" endtime="${fmt(caseEnd)}"/>\n` +
        `    </test>\n`;
      manualFailTotal += 1;
    }
    runningMs = caseEnd;
  }

  const manualEnd = runningMs;
  const manualSuiteXml =
    `  <suite id="${manualId}" name="${xmlEscape(manualName)}" source="${VROOT}/Manual_Checklist">\n` +
    `    <status status="${
      manualFailTotal > 0 ? "FAIL" : "PASS"
    }" starttime="${fmt(manualStart)}" endtime="${fmt(manualEnd)}"/>\n` +
    manualInner +
    `  </suite>\n`;

  // Root suite
  const rootStart = baseMs;
  const rootEnd = runningMs;
  const generated = fmt(baseMs);
  const robotXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<robot generator="api-validator" generated="${generated}" rpa="false" schemaversion="4">\n` +
    `  <suite id="${rootId}" name="${xmlEscape(rootName)}" source="${VROOT}">\n` +
    `    <status status="${
      autoFailTotal + manualFailTotal > 0 ? "FAIL" : "PASS"
    }" starttime="${fmt(rootStart)}" endtime="${fmt(rootEnd)}"/>\n` +
    automatedSuiteXml +
    manualSuiteXml +
    `  </suite>\n` +
    `</robot>`;

  const blob = new Blob([robotXml], { type: "application/xml" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "robot-report.xml";
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
    // Helpers
    const xmlEscape = (value: any) => {
      const s = String(value ?? "");
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
    };

    // Robot Framework time format: YYYYMMDD HH:MM:SS.mmm
    const fmt = (ms: number) => {
      const d = new Date(ms);
      const pad = (n: number, w = 2) => String(n).padStart(w, "0");
      const y = d.getFullYear();
      const M = pad(d.getMonth() + 1);
      const D = pad(d.getDate());
      const h = pad(d.getHours());
      const m = pad(d.getMinutes());
      const s = pad(d.getSeconds());
      const ms3 = pad(d.getMilliseconds(), 3);
      return `${y}${M}${D} ${h}:${m}:${s}.${ms3}`;
    };

    const safePath = (s: string) =>
      String(s ?? "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^\w\-\.]/g, "");
    const VROOT = "virtual:///Compliance_Validation";

    // ID helpers in Robot format
    const suiteId = (...segments: number[]) => `s${segments.join("-s")}`;
    const testId = (suiteIdStr: string, idx: number) => `${suiteIdStr}-t${idx}`;

    // Group diagnostics by source
    const grouped: Record<string, any[]> = {};
    diagnostics.forEach((diag) => {
      const key = diag?.source ? String(diag.source) : "unknown";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(diag);
    });

    const failedRuleIds = new Set(diagnostics.map((d) => d.source));
    const passedRules: any[] = Object.values(selectedRules).filter(
      (rule: any) => !failedRuleIds.has(rule.id)
    );

    // Timing model
    const CASE_MS = 200;
    const GAP_MS = 500;
    const baseMs = Date.now();

    // Root suite
    const rootName = "Compliance Validation";
    const rootId = suiteId(1);

    // Child suite IDs
    const automatedName = "Automated Compliance Validation Report";
    const automatedId = suiteId(1, 1);
    const manualName = "Manual Checklist";
    const manualId = suiteId(1, 2);

    // Build Automated subtree
    let autoInner = "";
    let autoSuiteCounter = 0;
    let autoFailTotal = 0;
    let runningMs = baseMs;

    const groupKeys = Object.keys(grouped);
    for (let gi = 0; gi < groupKeys.length; gi++) {
      const source = groupKeys[gi];
      const diags = grouped[source];
      autoSuiteCounter += 1;

      const subSuiteId = `${automatedId}-s${autoSuiteCounter}`;
      const suiteStart = runningMs;
      let testsXml = "";

      for (let ti = 0; ti < diags.length; ti++) {
        const diag = diags[ti];
        const caseStart = runningMs;
        const caseEnd = caseStart + CASE_MS;

        const v = editorViewRef.current as any;
        const docLen = v?.state?.doc?.length ?? 0;
        const within = typeof diag?.from === "number" && diag.from >= 0 && diag.from < docLen;
        const lineNumber = within ? v.state.doc.lineAt(diag.from).number : "N/A";

        const tName = `Line: ${lineNumber}`;
        const severity = xmlEscape(getSeverityLabel(diag?.severity));
        const msgText = `${severity}: ${diag?.message ?? ""}`;
        const tId = testId(subSuiteId, ti + 1);

        testsXml +=
          `      <test id="${tId}" name="${xmlEscape(tName)}">\n` +
          `        <msg timestamp="${fmt(
            caseStart
          )}" level="${
            severity === "ERROR" || severity === "CRITICAL" ? "ERROR" : "FAIL"
          }">${xmlEscape(msgText)}</msg>\n` +
          `        <status status="FAIL" starttime="${fmt(
            caseStart
          )}" endtime="${fmt(caseEnd)}"/>\n` +
          `      </test>\n`;

        autoFailTotal += 1;
        runningMs = caseEnd;
      }

      const suiteEnd = runningMs;
      autoInner +=
        `    <suite id="${subSuiteId}" name="${xmlEscape(source)}" source="${VROOT}/Automated_Compliance_Validation_Report/${safePath(source)}.robot">\n` +
        `      <status status="FAIL" starttime="${fmt(
          suiteStart
        )}" endtime="${fmt(suiteEnd)}"/>\n` +
        testsXml +
        `    </suite>\n`;

      runningMs += GAP_MS;
    }

    // Optional Passed Rules
    if (passedRules.length > 0) {
      autoSuiteCounter += 1;
      const subSuiteId = `${automatedId}-s${autoSuiteCounter}`;
      const suiteStart = runningMs;
      let testsXml = "";

      for (let i = 0; i < passedRules.length; i++) {
        const rule = passedRules[i];
        const caseStart = runningMs;
        const caseEnd = caseStart + CASE_MS;
        const tName = `Rule ${rule.id} - ${rule.title ?? rule.message ?? ""}`;
        const tId = testId(subSuiteId, i + 1);

        testsXml +=
          `      <test id="${tId}" name="${xmlEscape(tName)}">\n` +
          `        <msg timestamp="${fmt(
            caseStart
          )}" level="INFO">Passed</msg>\n` +
          `        <status status="PASS" starttime="${fmt(
            caseStart
          )}" endtime="${fmt(caseEnd)}"/>\n` +
          `      </test>\n`;

        runningMs = caseEnd;
      }

      const suiteEnd = runningMs;
      autoInner +=
        `    <suite id="${subSuiteId}" name="Passed Rules" source="${VROOT}/Automated_Compliance_Validation_Report/Passed_Rules.robot">\n` +
        `      <status status="PASS" starttime="${fmt(
          suiteStart
        )}" endtime="${fmt(suiteEnd)}"/>\n` +
        testsXml +
        `    </suite>\n`;

      runningMs += GAP_MS;
    }

    const automatedStart = baseMs;
    const automatedEnd = runningMs;
    const automatedSuiteXml =
      `  <suite id="${automatedId}" name="${xmlEscape(automatedName)}" source="${VROOT}/Automated_Compliance_Validation_Report">\n` +
      `    <status status="${
        autoFailTotal > 0 ? "FAIL" : "PASS"
      }" starttime="${fmt(automatedStart)}" endtime="${fmt(automatedEnd)}"/>\n` +
      autoInner +
      `  </suite>\n`;

    // --- Manual suite ---
    let manualInner = "";
    let manualFailTotal = 0;
    const manualStart = runningMs;

    for (let i = 0; i < manualRules.length; i++) {
      const rule = manualRules[i];
      const caseStart = runningMs;
      const caseEnd = caseStart + CASE_MS;
      const tName = `${rule.id} - ${rule.title}`;
      const isPass = !!rule?.verified;
      const rawMsg = convertMarkdownToPlainText(rule?.message ?? "");
      const tId = testId(manualId, i + 1);

      if (isPass) {
        manualInner +=
          `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
          `      <msg timestamp="${fmt(caseStart)}" level="INFO">Verified</msg>\n` +
          `      <status status="PASS" starttime="${fmt(
            caseStart
          )}" endtime="${fmt(caseEnd)}"/>\n` +
          `    </test>\n`;
      } else {
        manualInner +=
          `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
          `      <msg timestamp="${fmt(
            caseStart
          )}" level="FAIL">Manual rule not verified: ${xmlEscape(
            rule?.option ?? ""
          )} — ${xmlEscape(rawMsg)}</msg>\n` +
          `      <status status="FAIL" starttime="${fmt(
            caseStart
          )}" endtime="${fmt(caseEnd)}"/>\n` +
          `    </test>\n`;
        manualFailTotal += 1;
      }
      runningMs = caseEnd;
    }

    const manualEnd = runningMs;
    const manualSuiteXml =
      `  <suite id="${manualId}" name="${xmlEscape(manualName)}" source="${VROOT}/Manual_Checklist">\n` +
      `    <status status="${
        manualFailTotal > 0 ? "FAIL" : "PASS"
      }" starttime="${fmt(manualStart)}" endtime="${fmt(manualEnd)}"/>\n` +
      manualInner +
      `  </suite>\n`;

    // Root suite
    const rootStart = baseMs;
    const rootEnd = runningMs;
    const generated = fmt(baseMs);
    const robotXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<robot generator="api-validator" generated="${generated}" rpa="false" schemaversion="4">\n` +
      `  <suite id="${rootId}" name="${xmlEscape(rootName)}" source="${VROOT}">\n` +
      `    <status status="${
        autoFailTotal + manualFailTotal > 0 ? "FAIL" : "PASS"
      }" starttime="${fmt(rootStart)}" endtime="${fmt(rootEnd)}"/>\n` +
      automatedSuiteXml +
      manualSuiteXml +
      `  </suite>\n` +
      `</robot>`;
    // Send to Next.js proxy instead of calling ReportPortal directly from the browser
    const res = await fetch('/api/reportportal', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: JSON.stringify({
        robotXml,
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
