import type { NextApiRequest, NextApiResponse } from 'next';
import { reportPortalClient } from '@/clients/reportportal';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method === 'GET') {
    try {
      const {project, launchId} = req.query;
      if (!project || !launchId) {
        return res.status(400).json({error: 'Missing required query parameters: project and launchId'});
      }

      const result = await reportPortalClient.getLaunchClusters({
        project: String(project),
        launchId: String(launchId),
      });

      return res.status(200).json(result);
    } catch (error: any) {
      console.error('Error fetching launch clusters:', error);
      return res.status(500).json({error: error?.message || 'Unknown error'});
    }
  }

  // This should not be reached, but in case
  return res.status(500).json({ error: 'Unknown error' });
}
