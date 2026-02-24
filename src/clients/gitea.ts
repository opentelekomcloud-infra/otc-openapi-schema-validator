import axios from 'axios';
import yaml from 'js-yaml';

const log = {
  debug: (...args: any[]) => console.debug("[Gitea]", ...args),
};

class GiteaClient {
  private baseUrl: string;
  private token: string;

  constructor() {
    this.baseUrl = process.env.GITEA_BASE_URL!;
    this.token = process.env.GITEA_TOKEN!;

    if (!this.baseUrl || !this.token) {
      throw new Error('Missing required Gitea environment variables');
    }
  }

  async fetchYamlFile(repo: string, path: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1/repos/docs/${repo}/raw${path}`;

    log.debug('fetchYamlFile', {
      repo,
      path,
      url,
      baseUrl: this.baseUrl,
    });

    const response = await axios.get(url, {
      responseType: 'text',
      headers: {
        Authorization: `token ${this.token}`,
      },
      validateStatus: () => true, // we'll handle non-200 manually
    });

    log.debug('gitea response', {
      status: response.status,
      contentType: response.headers['content-type'],
    });

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch file from Gitea: HTTP ${response.status} (${repo}/${path})`
      );
    }

    if (typeof response.data !== 'string' || !response.data.trim()) {
      throw new Error(`Empty response from Gitea for ${repo}/${path}`);
    }

    let spec;
    try {
      spec = yaml.load(response.data, { json: true });
    } catch (e: any) {
      throw new Error(`Invalid YAML in ${path}: ${e.message}`);
    }

    return spec;
  }
}

export const giteaClient = new GiteaClient();
