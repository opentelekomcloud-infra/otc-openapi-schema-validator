import {convertMarkdownToPlainText} from '@/utils/utils';
import {getSeverityLabel} from '@/utils/mapSeverity';

// Build Robot Framework compliant XML (schema v4) from diagnostics + rules
export function buildRobotXml(
  diagnostics: any[],
  selectedRules: Record<string, any>,
  manualRules: any[],
  content?: string
): string {
  // Helpers
  const xmlEscape = (value: any) => {
    const s = String(value ?? '');
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const fmt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
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
    String(s ?? '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^\w\-\.]/g, '');

  const extractRuleId = (raw: any): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    // Direct ID like "2.4.1.5"
    let m = raw.match(/^(\d+(?:\.\d+)+)\b/);
    if (m) return m[1];
    // Phrases like "Rule 2.4.1.5 - ..."
    m = raw.match(/\bRule\s+(\d+(?:\.\d+)+)\b/i);
    if (m) return m[1];
    return undefined;
  };

  const VROOT = 'virtual:///Compliance_Validation';
  const suiteId = (...segments: number[]) => `s${segments.join('-s')}`;
  const testId = (suiteIdStr: string, idx: number) => `${suiteIdStr}-t${idx}`;

  const grouped: Record<string, any[]> = {};
  const failedRuleIds = new Set<string>();
  diagnostics.forEach((diag) => {
    const key = extractRuleId((diag as any)?.ruleId ?? (diag as any)?.source ?? (diag as any)?.message) || 'unknown';
    if (key !== 'unknown') failedRuleIds.add(key);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(diag);
  });

  const passedRules: any[] = Object.values(selectedRules || {}).filter((rule: any) => !failedRuleIds.has(rule.id));
  // Timing model
  const CASE_MS = 200;
  const GAP_MS = 500;
  const baseMs = Date.now();

  // IDs
  const rootName = 'Compliance Validation';
  const rootId = suiteId(1);
  const automatedName = 'Automated Compliance Validation Report';
  const automatedId = suiteId(1, 1);
  const manualName = 'Manual Checklist';
  const manualId = suiteId(1, 2);

  // Automated subtree
  let autoInner = '';
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
    let testsXml = '';

    for (let ti = 0; ti < diags.length; ti++) {
      const diag = diags[ti];
      const caseStart = runningMs;
      const caseEnd = caseStart + CASE_MS;

      // Line number: prefer diag.lineNumber; otherwise derive from `content` and `diag.from`
      let lineNumber: number | string = 'N/A';
      if (typeof diag?.lineNumber === 'number') {
        lineNumber = diag.lineNumber;
      } else if (typeof diag?.from === 'number') {
        if (typeof content === 'string' && content.length > 0) {
          const idx = Math.max(0, Math.min(diag.from, content.length));
          // Count newlines up to the index and add 1 (1-based line numbers)
          let count = 1;
          for (let i = 0; i < idx; i++) {
            if (content.charCodeAt(i) === 10 /* \n */) count++;
          }
          lineNumber = count;
        } else {
          // Fallback to raw offset if content is unavailable
          lineNumber = diag.from;
        }
      }
      const tName = `Line: ${lineNumber}`;
      const severity = xmlEscape(getSeverityLabel(diag?.severity));
      const msgText = `${severity}: ${diag?.message ?? ''}`;
      const tId = testId(subSuiteId, ti + 1);

      testsXml +=
        `      <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `        <msg timestamp="${fmt(caseStart)}" level="${
          severity === 'ERROR' || severity === 'CRITICAL' ? 'ERROR' : 'FAIL'
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

  // Passed Rules suite
  if (passedRules.length > 0) {
    autoSuiteCounter += 1;
    const subSuiteId = `${automatedId}-s${autoSuiteCounter}`;
    const suiteStart = runningMs;
    let testsXml = '';

    for (let i = 0; i < passedRules.length; i++) {
      const rule = passedRules[i];
      const caseStart = runningMs;
      const caseEnd = caseStart + CASE_MS;
      const tName = `Rule ${rule.id} - ${rule.title ?? rule.message ?? ''}`;
      const tId = testId(subSuiteId, i + 1);

      testsXml +=
        `      <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `        <msg timestamp="${fmt(caseStart)}" level="INFO">Passed</msg>\n` +
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
      autoFailTotal > 0 ? 'FAIL' : 'PASS'
    }" starttime="${fmt(automatedStart)}" endtime="${fmt(automatedEnd)}"/>\n` +
    autoInner +
    `  </suite>\n`;

  // Manual Checklist suite
  let manualInner = '';
  let manualFailTotal = 0;
  const manualStart = runningMs;

  for (let i = 0; i < manualRules.length; i++) {
    const rule = manualRules[i];
    const caseStart = runningMs;
    const caseEnd = caseStart + CASE_MS;
    const tName = `${rule.id} - ${rule.title}`;
    const isPass = !!rule?.verified;
    const rawMsg = convertMarkdownToPlainText(rule?.message ?? '');
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
          rule?.option ?? ''
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
      manualFailTotal > 0 ? 'FAIL' : 'PASS'
    }" starttime="${fmt(manualStart)}" endtime="${fmt(manualEnd)}"/>\n` +
    manualInner +
    `  </suite>\n`;

  const rootStart = baseMs;
  const rootEnd = runningMs;
  const generated = fmt(baseMs);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<robot generator="api-validator" generated="${generated}" rpa="false" schemaversion="4">\n` +
    `  <suite id="${rootId}" name="${xmlEscape(rootName)}" source="${VROOT}">\n` +
    `    <status status="${
      autoFailTotal + manualFailTotal > 0 ? 'FAIL' : 'PASS'
    }" starttime="${fmt(rootStart)}" endtime="${fmt(rootEnd)}"/>\n` +
    automatedSuiteXml +
    manualSuiteXml +
    `  </suite>\n` +
    `</robot>`;
}
