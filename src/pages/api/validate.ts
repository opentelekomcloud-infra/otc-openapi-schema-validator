import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runLinter } from '@/lib/linter/runLinter';
import { buildRobotXml } from '@/lib/export/buildRobotXml';
import { reportPortalClient } from '@/clients/reportportal';
import yaml from "js-yaml";

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
 *   path: "path_to_yaml_spec",               // required
 *   manual_rules?: ["id_1","id_2",...],      // optional (select subset); loads ALL then filters if provided
 *   auto_rules?: ["id_1","id_2",...],        // optional (select subset); loads ALL then filters if provided
 *   export?: "pdf" | "xml",                  // optional; xml returns JUnit; pdf = not yet implemented server-side
 *   out?: "path_to_out_file"                 // required only for export=pdf (currently returns 501)
 * }
 */

interface ValidateRequestBody {
  path: string;
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

    const { path: specPathInput, manual_rules, auto_rules, export: exportMode, out, ruleset = 'default' } = (body || {}) as ValidateRequestBody & Record<string, any>;

    // Validate required field
    if (!specPathInput || (specPathInput.trim() === '')) {
      return res.status(400).json({ error: 'Missing required "path"' });
    }

    const specAbs = resolvePath(specPathInput);
    let specText = '';
    try {
      specText = await fs.readFile(specAbs, 'utf8');
    } catch {
      return res.status(400).json({ error: `Cannot read file: ${specAbs}` });
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

    // Export options
    if (exportMode === 'xml') {
      // Build Robot XML and send to ReportPortal with default settings (no extra API params)
      const selectedRulesMap: Record<string, any> = Object.fromEntries((auto || []).filter(r => r?.id).map(r => [r.id, r]));
      const xml = buildRobotXml(diagnostics, selectedRulesMap, manual, specText);

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

      return res.status(200).json({ success: true, message: result });
    }

    if (exportMode === 'pdf') {
      if (!out) {
        return res.status(400).json({ error: 'Parameter "out" is required when export="pdf".' });
      }
      return res.status(501).json({ error: 'PDF export is not implemented on the server yet. Use the UI export.' });
    }

    // Default JSON response
    return res.status(200).json({
      spec: path.basename(specAbs),
      diagnostics,
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
