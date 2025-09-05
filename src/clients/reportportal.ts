import JSZip from "jszip";

export type RPAttribute = { key?: string; value: string };
export type RPMode = 'DEFAULT' | 'DEBUG';

export class ReportPortalClient {
  private endpoint: string;
  private apiKey: string;

  constructor() {
    this.endpoint = process.env.REPORTPORTAL_ENDPOINT!;
    this.apiKey = process.env.REPORTPORTAL_API_KEY!;

    if (!this.endpoint || !this.apiKey) {
      throw new Error('Missing REPORTPORTAL_ENDPOINT or REPORTPORTAL_API_KEY');
    }
  }

  /**
   * Import a JUnit XML file using the plugin endpoint (POST /api/v1/plugin/{project}/RobotFramework/import) with a ZIP file and launchImportRq.
   */
  async importLaunch(params: {
    xml: string; // JUnit XML string
    project: string;
    launch: string;
    description?: string;
    attributes?: RPAttribute[];
    mode?: RPMode;
  }): Promise<string> {
    const { xml, project, launch, description, attributes, mode } = params;

    if (!this.endpoint || !this.apiKey) {
      throw new Error('ReportPortal config missing on server: REPORTPORTAL_ENDPOINT/REPORTPORTAL_API_KEY');
    }

    const url = `${this.endpoint.replace(/\/$/, '')}/plugin/${project}/RobotFramework/import`;
    // Build ZIP with the JUnit XML inside as lint-report.xml
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
      startTime: new Date().toISOString(),
      attributes,
    };
    const launchBlob = new Blob([JSON.stringify(launchImportRq)], { type: 'application/json' });
    form.append('launchImportRq', launchBlob, 'launchImportRq.json');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form as any,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `ReportPortal responded with status ${res.status}`);
    }
    console.log(text)
    return text;
  }
}

export const reportPortalClient = new ReportPortalClient();
