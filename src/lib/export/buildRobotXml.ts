import {convertMarkdownToPlainText} from '@/utils/utils';
import { getSeverityLabel } from '@/utils/mapSeverity';

// Build Robot Framework compliant XML (schema v4) from diagnostics + rules
export function buildRobotXml(
  diagnostics: any[],
  selectedRules: Record<string, any>,
  manualRules: any[],
  content?: string,
  skipManual = false
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

  const extractRuleId = (raw: any): string | undefined => {
    if (typeof raw !== 'string') return undefined;

    const patterns: RegExp[] = [
      /\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+)\b/i,            // direct hyphenated ID
      /\bRule\s+([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+)\b/i,     // "Rule <hyphenated>"
      /(\d+(?:\.\d+)+)\b/,                                  // direct dotted numeric ID
      /\bRule\s+(\d+(?:\.\d+)+)\b/i                        // "Rule <dotted>"
    ];

    let best: { value: string; index: number } | undefined;

    for (const re of patterns) {
      const m = re.exec(raw);
      if (m && m[1]) {
        const idx = (m as any).index ?? raw.indexOf(m[0]);
        if (best === undefined || idx < best.index) {
          best = { value: m[1], index: idx };
        }
      }
    }

    return best?.value;
  };

  const findRuleMeta = (id: string): any => {
    const direct = (selectedRules || {})[id];
    if (direct) return direct;
    return Object.values(selectedRules || {}).find((r: any) => r?.id === id);
  };

  const computeLineNumber = (diag: any): number | string => {
    if (typeof diag?.lineNumber === 'number') return diag.lineNumber;
    if (typeof diag?.from === 'number') {
      if (typeof content === 'string' && content.length > 0) {
        const idx = Math.max(0, Math.min(diag.from, content.length));
        let count = 1;
        for (let i = 0; i < idx; i++) {
          if (content.charCodeAt(i) === 10) count++;
        }
        return count;
      }
      return diag.from;
    }
    return 'N/A';
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
  let autoFailTotal = 0;
  let runningMs = baseMs;

  const groupKeys = Object.keys(grouped);

  // Failed Rules suite: one test per unique failed rule; message includes rule.message + breaches list
  let failedRulesInner = '';
  let failedRulesCount = 0;

  const failedSuiteId = `${automatedId}-s1`;
  const failedSuiteStart = runningMs;

  for (let i = 0; i < groupKeys.length; i++) {
    const source = groupKeys[i];
    const diags = grouped[source] || [];

    const meta = source === 'unknown' ? undefined : findRuleMeta(source);
    const title = meta?.title ?? meta?.name ?? '';
    const messageHeader = meta?.message ?? title ?? meta?.name ?? '';

    const caseStart = runningMs;
    const caseEnd = caseStart + CASE_MS;

    const testName =
      source === 'unknown'
        ? (title || 'Unknown Rule')
        : `Rule ${source}${title ? ` - ${title}` : ''}`;

    const breaches = diags
      .map((d: any) => {
        const ln = computeLineNumber(d);
        const sev = getSeverityLabel(d?.severity);
        return `- ${sev} | Line ${ln}: ${d?.message ?? ''}`;
      })
      .join('\n');

    const fullMsg = `${messageHeader || ''}${(messageHeader && breaches) ? '\n' : ''}${breaches}`;

    const tId = testId(failedSuiteId, i + 1);
    failedRulesInner +=
      `      <test id="${tId}" name="${xmlEscape(testName)}">\n` +
      `        <msg timestamp="${fmt(caseStart)}" level="FAIL">${xmlEscape(fullMsg)}</msg>\n` +
      `        <status status="FAIL" starttime="${fmt(caseStart)}" endtime="${fmt(caseEnd)}"/>\n` +
      `      </test>\n`;

    failedRulesCount += 1;
    autoFailTotal += 1;
    runningMs = caseEnd;
  }

  const failedSuiteEnd = runningMs;
  autoInner +=
    `    <suite id="${failedSuiteId}" name="Failed Rules" source="${VROOT}/Automated_Compliance_Validation_Report/Failed_Rules.robot">\n` +
    `      <status status="${failedRulesCount > 0 ? 'FAIL' : 'PASS'}" starttime="${fmt(failedSuiteStart)}" endtime="${fmt(failedSuiteEnd)}"/>\n` +
    failedRulesInner +
    `    </suite>\n`;

  runningMs += GAP_MS;

  // Passed Rules suite
  const subSuiteId = `${automatedId}-s2`;
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

    if (skipManual) {
      manualInner +=
        `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `      <msg timestamp="${fmt(caseStart)}" level="INFO">Skipped in API export:\n ${xmlEscape(rule?.option ?? '')} — ${xmlEscape(rawMsg)}</msg>\n` +
        `      <status status="SKIP" starttime="${fmt(caseStart)}" endtime="${fmt(caseEnd)}"/>\n` +
        `    </test>\n`;
    } else if (isPass) {
      manualInner +=
        `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `      <msg timestamp="${fmt(caseStart)}" level="INFO">Verified:\n ${xmlEscape(rule?.option ?? '')} — ${xmlEscape(rawMsg)}</msg>\n` +
        `      <status status="PASS" starttime="${fmt(caseStart)}" endtime="${fmt(caseEnd)}"/>\n` +
        `    </test>\n`;
    } else {
      manualInner +=
        `    <test id="${tId}" name="${xmlEscape(tName)}">\n` +
        `      <msg timestamp="${fmt(caseStart)}" level="FAIL">Manual rule not verified:\n ${xmlEscape(rule?.option ?? '')} — ${xmlEscape(rawMsg)}</msg>\n` +
        `      <status status="FAIL" starttime="${fmt(caseStart)}" endtime="${fmt(caseEnd)}"/>\n` +
        `    </test>\n`;
      manualFailTotal += 1;
    }
    runningMs = caseEnd;
  }

  const manualEnd = runningMs;
  const manualSuiteXml =
    `  <suite id="${manualId}" name="${xmlEscape(manualName)}" source="${VROOT}/Manual_Checklist">\n` +
    `    <status status="${skipManual ? 'SKIP' : (manualFailTotal > 0 ? 'FAIL' : 'PASS')}" starttime="${fmt(manualStart)}" endtime="${fmt(manualEnd)}"/>\n` +
    manualInner +
    `  </suite>\n`;

  const rootStart = baseMs;
  const rootEnd = runningMs;
  const generated = fmt(baseMs);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<robot generator="api-validator" generated="${generated}" rpa="false" schemaversion="4">\n` +
    `  <suite id="${rootId}" name="${xmlEscape(rootName)}" source="${VROOT}">\n` +
    `    <status status="${
      (autoFailTotal + (skipManual ? 0 : manualFailTotal)) > 0 ? 'FAIL' : 'PASS'
    }" starttime="${fmt(rootStart)}" endtime="${fmt(rootEnd)}"/>\n` +
    automatedSuiteXml +
    manualSuiteXml +
    `  </suite>\n` +
    `</robot>`;
}
