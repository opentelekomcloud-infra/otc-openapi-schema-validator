import axios, { type AxiosProxyConfig } from 'axios';
import https from 'node:https';
import * as yaml from 'js-yaml';

export class GiteaClient {
  private baseUrl: string;
  private token: string;
  private proxy: AxiosProxyConfig | undefined;
  private httpsAgent = new https.Agent({ rejectUnauthorized: true });

  constructor(options: { baseUrl?: string; token?: string; proxy?: AxiosProxyConfig } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.GITEA_BASE_URL ?? '';
    this.token = options.token ?? process.env.GITEA_TOKEN ?? '';
    this.proxy = options.proxy;

    if (!this.baseUrl || !this.token) {
      throw new Error('Missing required Gitea environment variables');
    }
  }

  async fetchRawYamlFile(repo: string, path: string, ref?: string): Promise<string> {
    const filePath = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v1/repos/docs/${encodeURIComponent(repo)}/contents/${filePath}`;
    let response;
    try {
      response = await axios.get<unknown>(url, {
        responseType: 'json',
        headers: { Authorization: `token ${this.token}`, Accept: 'application/json' },
        proxy: this.proxy,
        httpsAgent: this.httpsAgent,
        timeout: 15000,
        maxRedirects: 0,
        params: ref === undefined ? undefined : { ref },
        validateStatus: () => true,
      });
    } catch (error) {
      const code = axios.isAxiosError(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code)
        ? error.code : 'REQUEST_FAILED';
      throw new Error(`Failed to fetch file from Gitea: ${code}`);
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch file from Gitea: HTTP ${response.status}`
      );
    }

    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !('type' in data) || data.type !== 'file' ||
        !('encoding' in data) || data.encoding !== 'base64' ||
        !('content' in data) || typeof data.content !== 'string') {
      throw new Error('Unsupported contents response from Gitea: expected a base64-encoded file');
    }
    const encoded = data.content.replace(/[ \t\r\n]/g, '');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) {
      throw new Error('Invalid base64 file content from Gitea');
    }
    const content = decoded.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(decoded)) {
      throw new Error('Invalid UTF-8 file content from Gitea');
    }
    if (!content.trim()) throw new Error('Empty response from Gitea');
    return content;
  }

  async fetchYamlFile(repo: string, path: string, ref?: string): Promise<unknown> {
    const content = await this.fetchRawYamlFile(repo, path, ref);
    try {
      return yaml.load(content, { json: true });
    } catch (error) {
      const detail = error instanceof yaml.YAMLException
        ? `${error.reason}${error.mark ? ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}` : ''}`
        : 'Unable to parse the response';
      throw new Error(`Invalid YAML from Gitea: ${detail}`);
    }
  }
}

export const giteaClient = new GiteaClient();
