import JSZip from "jszip";
import axios, { type AxiosProxyConfig } from "axios";
import https from "node:https";

const log = {
  debug: (...args: any[]) => console.debug("[ReportPortal]", ...args),
};

export type RPAttribute = { key?: string; value: string };
export type RPMode = 'DEFAULT' | 'DEBUG';

export class ReportPortalClient {
  private endpoint: string;
  private apiKey: string;
  private proxy: AxiosProxyConfig | undefined;
  private httpsAgent = new https.Agent({ rejectUnauthorized: true });

  constructor(options: { proxy?: AxiosProxyConfig } = {}) {
    this.endpoint = process.env.REPORTPORTAL_ENDPOINT!;
    this.apiKey = process.env.REPORTPORTAL_API_KEY!;
    this.proxy = options.proxy;

    if (!this.endpoint || !this.apiKey) {
      throw new Error('Missing REPORTPORTAL_ENDPOINT or REPORTPORTAL_API_KEY');
    }
  }

  private async request(url: string, options: RequestInit): Promise<string> {
    let response;
    try {
      response = await axios.request<string>({
        url,
        method: options.method,
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        data: options.body,
        proxy: this.proxy,
        httpsAgent: this.httpsAgent,
        timeout: options.method === "POST" ? 120000 : 15000,
        maxRedirects: 0,
        responseType: "text",
        transformResponse: [(data: string) => data],
        validateStatus: () => true,
      });
    } catch (error) {
      const code = axios.isAxiosError(error) && typeof error.code === "string" && /^[A-Z0-9_]{1,60}$/.test(error.code)
        ? error.code : "REQUEST_FAILED";
      throw new Error(`Failed to request ReportPortal: ${code}`);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`ReportPortal responded with status ${response.status}`);
    }
    if (typeof response.data !== "string") {
      throw new Error("Unsupported response from ReportPortal");
    }
    return response.data;
  }

  /**
   * Import Robot Framework XML using the plugin endpoint with a ZIP file and launchImportRq.
   */
  async importLaunch(params: {
    xml: string;
    project: string;
    launch: string;
    description?: string;
    attributes?: RPAttribute[];
    mode?: RPMode;
  }): Promise<string> {
    const { xml, project, launch, description, attributes, mode } = params;
    log.debug("Starting importing");
    if (!this.endpoint || !this.apiKey) {
      throw new Error('ReportPortal config missing on server: REPORTPORTAL_ENDPOINT/REPORTPORTAL_API_KEY');
    }

    const url = `${this.endpoint.replace(/\/$/, '')}/plugin/${project}/RobotFramework/import`;
    log.debug("Making request to: ", url);
    // Build ZIP with the Robot Framework XML inside as lint-report.xml
    const zip = new JSZip();
    zip.file('lint-report.xml', xml);
    const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });

    const form = new FormData();
    const zipBlob = new Blob([zipArrayBuffer], { type: 'application/x-zip-compressed' });
    form.append('file', zipBlob, 'lint-report.zip');

    const launchImportRq = {
      name: launch,
      description,
      mode: mode ?? 'DEFAULT',
      // startTime: new Date().toISOString(),
      attributes,
    };
    const launchBlob = new Blob([JSON.stringify(launchImportRq)], { type: 'application/json' });
    log.debug("Launch BLOB: ", launchBlob);
    form.append('launchImportRq', launchBlob, 'launchImportRq.json');
    log.debug("Attributes: ", form)
    const text = await this.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    console.log(text)
    return text;
  }

  /**
   * Get launch details by numeric ID using the official ReportPortal Service API.
   * API: GET /v1/:projectName/launch/:launchId
   */
  async getLaunchById(params: { project: string; launchId: number | string }): Promise<any> {
    const { project, launchId } = params;

    if (!this.endpoint || !this.apiKey) {
      throw new Error('ReportPortal config missing on server: REPORTPORTAL_ENDPOINT/REPORTPORTAL_API_KEY');
    }

    const url = `${this.endpoint.replace(/\/$/, '')}/${project}/launch/${launchId}`;

    const text = await this.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });

    try {
      return JSON.parse(text);
    } catch {
      // Fallback in case the server returns non-JSON content-type while still returning JSON string
      return text as any;
    }
  }


  /**
   * Get all index clusters of the launch.
   * API: GET /v1/:projectName/launch/cluster/:launchId
   */
  async getLaunchClusters(params: { project: string; launchId: number | string }): Promise<any> {
    const { project, launchId } = params;

    if (!this.endpoint || !this.apiKey) {
      throw new Error('ReportPortal config missing on server: REPORTPORTAL_ENDPOINT/REPORTPORTAL_API_KEY');
    }

    const url = `${this.endpoint.replace(/\/$/, '')}/${project}/launch/cluster/${launchId}`;

    const text = await this.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });

    try {
      return JSON.parse(text);
    } catch {
      return text as any;
    }
  }
}

export const reportPortalClient = new ReportPortalClient();
