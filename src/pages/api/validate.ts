import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'node:path';
import fs from 'node:fs/promises';
import { functionsMap, type SourceDiagnostic } from '@/lib/linter/runLinter';
import { runPreparedLinter } from '@/lib/linter/runPreparedLinter';
import { loadAllowedAbbreviationsOnServer } from '@/lib/server/abbreviations';
import { getImplementedRules, loadRuleCatalog } from '@/lib/linter/ruleCatalog';
import { buildRobotXml } from '@/lib/export/buildRobotXml';
import { reportPortalClient } from '@/clients/reportportal';
import { getSeverityLabel } from "@/utils/mapSeverity";
import { giteaClient } from '@/clients/gitea';
import { requireApiAuth } from "@/lib/apiAuth";
import { diagnosticLineNumber } from "@/lib/openapi/sourceMap";
import { diagnosticRuleId } from "@/lib/export/ruleOutcomes";
import { isRecord } from "@/lib/openapi/references";

const log = {
  debug: (...args: any[]) => console.debug("[Validate]", ...args),
};

// Allow large payloads (YAML specs can be big)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

/**
 * POST /api/validate
 * Body:
 * {
 *   // ONE of the following is required
 *   path?: string;                 // URL (http/https) OR server path (only if accessible)
 *   file_content?: string;         // raw YAML string of the spec (preferred when calling from browser)
 *
 *   // Selection
 *   manual_rules?: string[];       // optional (subset); loads ALL then filters if provided
 *   auto_rules?: string[];         // optional (subset); loads ALL then filters if provided
 *   exclude_manual_rules?: string[]; // optional; rule IDs to exclude from manual rules
 *   exclude_auto_rules?: string[];   // optional; rule IDs to exclude from auto rules
 *   exclude_issues?: Array<{ rule_id: string; line_number: number }>; // exclude matching rule findings on 1-based source lines
 *   ruleset?: string;              // optional; defaults to "default"
 *
 *   // Export
 *   export?: "pdf" | "xml" | "robot"; // robot returns Robot XML; xml imports to ReportPortal; pdf not implemented server-side
 *   out?: string;                  // required only for export=pdf (currently returns 501)
 * }
 */

interface IssueExclusion {
  rule_id: string;
  line_number: number;
}

function isIssueExclusion(value: unknown): value is IssueExclusion {
  return isRecord(value) && typeof value.rule_id === 'string' && value.rule_id.trim() !== '' &&
    typeof value.line_number === 'number' && Number.isSafeInteger(value.line_number) && value.line_number > 0;
}

interface ValidateRequestBody {
  path?: string;
  file_content?: string;
  manual_rules?: string[];
  auto_rules?: string[];
  exclude_manual_rules?: string[];
  exclude_auto_rules?: string[];
  exclude_issues?: IssueExclusion[];
  ruleset?: string;
  export?: 'pdf' | 'xml' | 'robot';
  out?: string;
}

interface ManualRule { id: string; title?: string; description?: string; [k: string]: any }
interface AutoRule   { id: string; name?: string; status?: string; option?: string; [k: string]: any }

function resolvePath(p: string) {
  return path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ process.cwd(), p);
}

async function listFilesDeep(dir: string, exts = ['.yaml', '.yml']): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory && e.isDirectory()) await walk(p);
      else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

/** Mirrors ManualChecksSelector: read all YAMLs in public/manual-checklist and aggregate rules */
async function loadAllManualRules(): Promise<ManualRule[]> {
  const root = path.join(process.cwd(), 'public', 'manual-checklist');
  const files = await listFilesDeep(root);
  const rules = await loadRuleCatalog(files, (file) => fs.readFile(file, 'utf8'));
  return rules.map((rule) => ({ ...rule, verified: false }));
}

// Helper for safe path joining
function safeJoin(base: string, segment: string) {
  const joined = path.join(base, segment || '');
  const resolvedBase = path.resolve(base) + path.sep;
  const resolved = path.resolve(joined) + path.sep;
  if (!resolved.startsWith(resolvedBase)) {
    throw new Error('Invalid path segment');
  }
  return resolved.slice(0, -1); // remove trailing sep we added
}

function parseGiteaUrl(rawUrl: string): { repo: string; path: string; ref?: string } | null {
  try {
    const u = new URL(rawUrl);
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length >= 7 && seg.slice(0, 4).join('/') === 'api/v1/repos/docs' &&
        seg[5] === 'contents') {
      const ref = u.searchParams.get('ref');
      if (ref === '') return null;
      return {
        repo: decodeURIComponent(seg[4]),
        path: seg.slice(6).map(decodeURIComponent).join('/'),
        ref: ref ?? undefined,
      };
    }
    if (seg.length >= 5 && (seg[2] === 'src' || seg[2] === 'raw')) {
      const repoName = seg[1];
      const qualifiedRef = ["branch", "tag", "commit"].includes(seg[3]);
      const refIndex = qualifiedRef ? 4 : 3;
      const filePath = seg.slice(refIndex + 1).map(decodeURIComponent).join('/');
      if (!filePath || !seg[refIndex]) return null;
      return { repo: decodeURIComponent(repoName), path: filePath, ref: decodeURIComponent(seg[refIndex]) };
    }
  } catch {
    // ignore
  }
  return null;
}

async function loadAllAutoRules(ruleset: string = 'default'): Promise<AutoRule[]> {
  const rootAll = path.join(process.cwd(), 'public', 'rulesets');
  const root = safeJoin(rootAll, ruleset);
  try {
    await fs.access(root);
  } catch {
    throw new Error(`Ruleset folder not found: ${ruleset}`);
  }
  const files = await listFilesDeep(root);
  const rules = await loadRuleCatalog(files, (file) => fs.readFile(file, 'utf8'));
  return getImplementedRules(rules, functionsMap);
}

function filterByIds<T extends { id?: string }>(items: T[], ids?: string[]) {
  if (!ids?.length) return items;
  const set = new Set(ids);
  return items.filter(r => r.id && set.has(r.id));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const t0 = Date.now();
  const principal = await requireApiAuth(req);
  if (!principal) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Next.js pages API: req.body can be object (application/json) or string (raw). Handle both.
    let body: any = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        try {
          const params = new URLSearchParams(body);
          body = Object.fromEntries(params.entries());
        } catch {
          return res.status(400).json({ error: 'Invalid request body. Expected JSON or form-encoded string.' });
        }
      }
    }

    const { path: specPathInput, file_content, manual_rules, auto_rules, exclude_manual_rules, exclude_auto_rules, exclude_issues, export: exportMode, out, ruleset = 'default' } = (body || {}) as ValidateRequestBody & Record<string, any>;

    if (exclude_issues !== undefined && (!Array.isArray(exclude_issues) || !exclude_issues.every(isIssueExclusion))) {
      return res.status(400).json({ error: 'Parameter "exclude_issues" must be an array of { rule_id: non-empty string, line_number: positive safe integer }.' });
    }

    // Validate required source: either file_content or path/url must be provided
    if ((!file_content || String(file_content).trim() === '') && (!specPathInput || String(specPathInput).trim() === '')) {
      return res.status(400).json({ error: 'Provide either "file_content" (preferred) or "path" (URL or server-accessible path).' });
    }

    let specText = '';
    const isHttpUrl = typeof specPathInput === 'string' && /^https?:\/\//i.test(specPathInput);

    if (typeof file_content === 'string' && file_content.trim() !== '') {
      log.debug('spec source', { type: 'file_content', length: file_content.length });
      // Preferred: client provided file content directly
      specText = file_content;
    } else if (isHttpUrl) {
      // If base URL belongs to internal Gitea (e.g., gitea.eco.*), use giteaClient
      try {
        const u = new URL(specPathInput!);
        const hostLc = u.host.toLowerCase();
        const isInternalGitea = hostLc.includes('gitea') && hostLc.includes('eco');

        log.debug('spec source', { type: 'url', url: specPathInput, isInternalGitea });

        if (isInternalGitea) {
          const parsed = parseGiteaUrl(specPathInput!);
          if (!parsed) {
            return res.status(400).json({ error: 'Unable to parse Gitea URL. Provide a repository file URL or /api/v1/repos/docs/:repo/contents/:path?ref=:ref' });
          }
          try {
            specText = await giteaClient.fetchRawYamlFile(parsed.repo, parsed.path, parsed.ref);
          } catch (e: any) {
            return res.status(400).json({ error: `Failed to load spec from Gitea: ${e?.message || 'unknown error'}` });
          }
        } else {
          // Fallback: direct fetch
          const resp = await fetch(specPathInput!);
          if (!resp.ok) {
            return res.status(400).json({ error: `Failed to fetch spec from URL: HTTP ${resp.status}` });
          }
          specText = await resp.text();
        }
      } catch (e: any) {
        return res.status(400).json({ error: `Invalid URL: ${e?.message || 'unknown error'}` });
      }
    } else if (typeof specPathInput === 'string' && specPathInput.trim() !== '') {
      log.debug('spec_source', { type: 'server_path', path: specPathInput });
      // Server path: only attempt if accessible, otherwise ask for file_content
      const specAbs = resolvePath(specPathInput);
      try {
        await fs.access(specAbs);
      } catch {
        return res.status(400).json({ error: `Cannot access path on server: ${specPathInput}. Send "file_content" or a URL instead.` });
      }
      try {
        specText = await fs.readFile(specAbs, 'utf8');
      } catch {
        return res.status(400).json({ error: `Cannot read file: ${specAbs}` });
      }
    }

    if (!specText || specText.trim() === '') {
      return res.status(400).json({ error: 'Specification content is empty after reading provided source.' });
    }

    // Load all rules, then filter if IDs provided
    let allManual: ManualRule[] = [];
    let allAuto: AutoRule[] = [];
    try {
      [allManual, allAuto] = await Promise.all([
        loadAllManualRules(),
        loadAllAutoRules(ruleset),
      ]);
    } catch (e: any) {
      if (typeof e?.message === 'string' && e.message.startsWith('Ruleset folder not found')) {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }
    log.debug('rules loaded: ', { manual_total: allManual.length, auto_total: allAuto.length, ruleset });
    let manual = filterByIds(allManual, manual_rules);
    let auto = filterByIds(allAuto, auto_rules);
    if (exclude_manual_rules?.length) {
      const excludeManualSet = new Set(exclude_manual_rules);
      manual = manual.filter(r => !r.id || !excludeManualSet.has(r.id));
    }

    if (exclude_auto_rules?.length) {
      const excludeAutoSet = new Set(exclude_auto_rules);
      auto = auto.filter(r => !r.id || !excludeAutoSet.has(r.id));
    }
    log.debug('rules selected: ', { manual_selected: manual.length, auto_selected: auto.length });

    // Run linter
    const { diagnostics, specTitle } = await runPreparedLinter(specText, auto, loadAllowedAbbreviationsOnServer);
    log.debug('lint done: ', { diagnostics_count: Array.isArray(diagnostics) ? diagnostics.length : 0, specTitle });
    const responseDiagnostic = (diagnostic: SourceDiagnostic) => ({
      ...diagnostic,
      lineNumber: diagnosticLineNumber(specText, diagnostic),
      severity: getSeverityLabel(diagnostic.severity),
    });
    const diagnosticsWithLines = diagnostics.map(responseDiagnostic);
    const validationResult = {
      diagnostics: diagnosticsWithLines,
      conversion: { converted: false },
      rules: {
        manual,
        auto,
        manual_total: allManual.length,
        auto_total: allAuto.length,
        manual_selected: manual.length,
        auto_selected: auto.length,
      },
    };
    const parserError = diagnostics.find((diagnostic) => diagnostic.source === "parser" && diagnostic.severity === "error");
    if (parserError) {
      return res.status(400).json({ ...validationResult, error: parserError.message });
    }

    const retainedDiagnostics: typeof diagnostics = [];
    const excludedDiagnostics: typeof diagnostics = [];
    for (const diagnostic of diagnostics) {
      const excluded = exclude_issues?.some((entry) =>
        entry.rule_id.trim() === diagnosticRuleId(diagnostic) &&
        entry.line_number === diagnosticLineNumber(specText, diagnostic));
      (excluded ? excludedDiagnostics : retainedDiagnostics).push(diagnostic);
    }
    const excludedResult = exclude_issues === undefined ? {} : {
      excluded_issues: excludedDiagnostics.map(responseDiagnostic),
    };
    const filteredValidationResult = {
      ...validationResult,
      diagnostics: retainedDiagnostics.map(responseDiagnostic),
      ...excludedResult,
    };
    const excludedRuleIds = new Set(excludedDiagnostics.map(diagnosticRuleId)
      .filter((id): id is string => id !== undefined));
    const fullyExcludedRuleIds = new Set([...excludedRuleIds].filter((id) =>
      !retainedDiagnostics.some((diagnostic) => diagnosticRuleId(diagnostic) === id)));
    log.debug('issue exclusions', { excluded: excludedDiagnostics.length, retained: retainedDiagnostics.length });

    // Export options
    if (exportMode === 'xml' || exportMode === 'robot') {
      const selectedRulesMap: Record<string, any> = Object.fromEntries(auto
        .filter(rule => rule.id && !fullyExcludedRuleIds.has(rule.id)).map(rule => [rule.id, rule]));
      const xml = buildRobotXml(retainedDiagnostics, selectedRulesMap, manual, specText, true);
      log.debug('export xml built: ', { xml_len: xml.length, diagnostics_count: retainedDiagnostics.length });
      if (exportMode === 'robot') {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="robot-report.xml"');
        return res.status(200).send(xml);
      }
      const project = 'openapi';
      const launch = `Service: ${specTitle ?? 'OpenAPI'}`;
      const description = `Latest launch for ${specTitle ?? 'OpenAPI'} - ${new Date().toISOString()}`;
      const mode: 'DEFAULT' | 'DEBUG' = 'DEFAULT';

      const result = await reportPortalClient.importLaunch({
        xml,
        project,
        launch,
        description,
        mode,
      });
      log.debug('reportportal import done', { type: typeof result });

      let payload: any = result;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = { raw: payload };
        }
      }
      log.debug('reportportal payload keys: ', { keys: payload && typeof payload === 'object' ? Object.keys(payload) : [] });
      log.debug('response', { mode: 'export xml', ms: Date.now() - t0 });
      return res.status(200).json({
        success: true,
        launch: payload,
        conversion: { converted: false },
        ...excludedResult,
      });
    }

    if (exportMode === 'pdf') {
      if (!out) {
        return res.status(400).json({ error: 'Parameter "out" is required when export="pdf".' });
      }
      return res.status(501).json({ error: 'PDF export is not implemented on the server yet. Use the UI export.' });
    }

    // Default JSON response
    log.debug('response', { mode: 'json', ms: Date.now() - t0, diagnostics: retainedDiagnostics.length });
    return res.status(200).json(filteredValidationResult);
  } catch (error: any) {
    console.error('Validate route error:', error);
    return res.status(500).json({ error: error?.message || 'Unknown error' });
  }
}
