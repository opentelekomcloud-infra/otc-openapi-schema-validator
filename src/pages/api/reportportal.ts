import type { NextApiRequest, NextApiResponse } from 'next';
import { reportPortalClient } from '@/clients/reportportal';

// Allow large XML payloads
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method === 'POST') {
    try {
      // Next.js gives you an object for application/json, but if the client sent text/plain
      // or a raw stringified JSON, req.body can be a string. Handle both.
      let body: any = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          // Not JSON; keep as string and try to parse as URLSearchParams (common when sent as text/plain)
          try {
            const params = new URLSearchParams(body);
            body = Object.fromEntries(params.entries());
          } catch {
            return res.status(400).json({ error: 'Invalid request body. Expected JSON or form-encoded string.' });
          }
        }
      }

      const { xml, launch, description, attributes, mode, project } = body || {};

      // Validate presence and non-empty strings
      const missing: string[] = [];
      if (!xml || (typeof xml === 'string' && xml.trim() === '')) missing.push('xml');
      if (!launch || (typeof launch === 'string' && launch.trim() === '')) missing.push('launch');
      if (!project || (typeof project === 'string' && project.trim() === '')) missing.push('project');

      if (missing.length) {
        return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
      }

      const result = await reportPortalClient.importLaunch({
        xml,
        project,
        launch,
        description,
        attributes,
        mode,
      });

      return res.status(200).json({ success: true, message: result });
    } catch (error: any) {
      console.error('ReportPortal proxy error:', error);
      return res.status(500).json({ error: error?.message || 'Unknown error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const { project, launchId } = req.query;
      if (!project || !launchId) {
        return res.status(400).json({ error: 'Missing required query parameters: project and launchId' });
      }

      const result = await reportPortalClient.getLaunchById({
        project: String(project),
        launchId: String(launchId),
      });

      return res.status(200).json(result);
    } catch (error: any) {
      console.error('Error fetching launch by ID:', error);
      return res.status(500).json({ error: error?.message || 'Unknown error' });
    }
  }

  // This should not be reached, but in case
  return res.status(500).json({ error: 'Unknown error' });
}
