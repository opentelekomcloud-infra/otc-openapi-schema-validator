import axios from 'axios';
import yaml from 'js-yaml';

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
    const url = `${this.baseUrl}/api/v1/repos/docs/${repo}/raw/${path}?token=${this.token}`;
    const response = await axios.get(url, {
      responseType: 'text',
    });

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
