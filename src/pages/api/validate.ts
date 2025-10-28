import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runLinter } from '@/lib/linter/runLinter';
import { buildRobotXml } from '@/lib/export/buildRobotXml';
import { reportPortalClient } from '@/clients/reportportal';
import yaml from "js-yaml";
import { getSeverityLabel } from "@/utils/mapSeverity";

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
 *   ruleset?: string;              // optional; defaults to "default"
 *
 *   // Export
 *   export?: "pdf" | "xml";     // optional; xml pushes Robot XML to ReportPortal; pdf not implemented server-side
 *   out?: string;                  // required only for export=pdf (currently returns 501)
 * }
 */

interface ValidateRequestBody {
  path?: string;
  file_content?: string;
  manual_rules?: string[];
  auto_rules?: string[];
  ruleset?: string;
  export?: 'pdf' | 'xml';
  out?: string;
}

interface ManualRule { id: string; title?: string; description?: string; [k: string]: any }
interface AutoRule   { id: string; name?: string; status?: string; option?: string; [k: string]: any }

function resolvePath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

async function loadYaml<T = any>(absPath: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(absPath, 'utf8');
    return yaml.load(txt) as T;
  } catch {
    return null;
  }
}

async function listFilesDeep(dir: string, exts = ['.yaml', '.yml']): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
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
  const acc: ManualRule[] = [];
  for (const f of files) {
    const data = await loadYaml<any>(f);
    if (data?.rules && Array.isArray(data.rules)) {
      for (const r of data.rules) acc.push({ ...r, verified: false });
    }
  }
  return acc;
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

async function loadAllAutoRules(ruleset: string = 'default'): Promise<AutoRule[]> {
  const rootAll = path.join(process.cwd(), 'public', 'rulesets');
  const root = safeJoin(rootAll, ruleset);
  try {
    await fs.access(root);
  } catch {
    throw new Error(`Ruleset folder not found: ${ruleset}`);
  }
  const files = await listFilesDeep(root);
  const acc: AutoRule[] = [];
  for (const f of files) {
    const data = await loadYaml<any>(f);
    if (data?.rules && Array.isArray(data.rules)) {
      for (const r of data.rules) {
        if ((r?.status || '').toLowerCase() === 'implemented') acc.push(r as AutoRule);
      }
    }
  }
  return acc;
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

    const { path: specPathInput, file_content, manual_rules, auto_rules, export: exportMode, out, ruleset = 'default' } = (body || {}) as ValidateRequestBody & Record<string, any>;

    // Validate required source: either file_content or path/url must be provided
    if ((!file_content || String(file_content).trim() === '') && (!specPathInput || String(specPathInput).trim() === '')) {
      return res.status(400).json({ error: 'Provide either "file_content" (preferred) or "path" (URL or server-accessible path).' });
    }

    let specText = '';
    const isHttpUrl = typeof specPathInput === 'string' && /^https?:\/\//i.test(specPathInput);

    if (typeof file_content === 'string' && file_content.trim() !== '') {
      // Preferred: client provided file content directly
      specText = file_content;
    } else if (isHttpUrl) {
      // URL: fetch the spec
      try {
        const resp = await fetch(specPathInput!);
        if (!resp.ok) {
          return res.status(400).json({ error: `Failed to fetch spec from URL: HTTP ${resp.status}` });
        }
        specText = await resp.text();
      } catch (e: any) {
        return res.status(400).json({ error: `Failed to fetch spec from URL: ${e?.message || 'unknown error'}` });
      }
    } else if (typeof specPathInput === 'string' && specPathInput.trim() !== '') {
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
    const manual = filterByIds(allManual, manual_rules);
    const auto = filterByIds(allAuto, auto_rules);
    // Run linter
    const { diagnostics, specTitle } = await runLinter(specText, auto);

    // Helper to compute line number (1-based) from character offset
    const computeLine = (text: string, idx: number) => {
      if (typeof idx !== 'number' || idx < 0) return 'N/A' as const;
      const clamped = Math.min(Math.max(0, idx), text.length);
      let line = 1;
      for (let i = 0; i < clamped; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) line++;
      }
      return line;
    };

    const diagnosticsWithLines = (diagnostics || []).map((d: any) => ({
      ...d,
      lineNumber: typeof d?.lineNumber === 'number' ? d.lineNumber : computeLine(specText, (d?.from as number) ?? -1),
      severity: getSeverityLabel(d?.severity),
    }));

    // Export options
    if (exportMode === 'xml') {
      // Build Robot XML and send to ReportPortal with default settings (no extra API params)
      const selectedRulesMap: Record<string, any> = Object.fromEntries((auto || []).filter(r => r?.id).map(r => [r.id, r]));
      const xml = buildRobotXml(diagnostics, selectedRulesMap, manual, specText, true);

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

      let payload: any = result;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = { raw: payload };
        }
      }

      return res.status(200).json({
        success: true,
        launch: payload,
      });
    }

    if (exportMode === 'pdf') {
      if (!out) {
        return res.status(400).json({ error: 'Parameter "out" is required when export="pdf".' });
      }
      return res.status(501).json({ error: 'PDF export is not implemented on the server yet. Use the UI export.' });
    }

    // Default JSON response
    return res.status(200).json({
      diagnostics: diagnosticsWithLines,
      rules: {
        manual,
        auto,
        manual_total: allManual.length,
        auto_total: allAuto.length,
        manual_selected: manual.length,
        auto_selected: auto.length,
      },
    });
  } catch (error: any) {
    console.error('Validate route error:', error);
    return res.status(500).json({ error: error?.message || 'Unknown error' });
  }
}
