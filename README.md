# T Cloud Public OpenAPI Schema Validator

A web-based tool built with **Next.js 16**, **React 19**, and **Tailwind CSS 4** for validating and visualizing OpenAPI schemas (YAML/JSON).
Upload a file in the UI, or use the API to submit content or load a server-accessible path or URL, including internal Gitea-hosted specs. Swagger 2.0 and OpenAPI 3.0.x documents are validated natively without automatic conversion or reference rewriting.

The default format-version rule accepts `swagger: "2.0"` (or numeric `2`) and
`openapi: "3.0.<patch>"`, for example `openapi: "3.0.3"`. Shortened or numeric
OpenAPI versions, OpenAPI 3.1, and OpenAPI 3.2 are not accepted. The format marker
is separate from `info.version`, which describes the API's own version.

Validation uses the selected rules; it is not a complete validation of every
nested object against the Swagger or OpenAPI standard.

---

## Getting Started
If you want to enable `ZITADEL` auth please read:
[Authorization](AUTHORIZATION.md)

Run server with ENABLE_AUTH=false to disable all `ZITADEL` integrations

### Prerequisites
- **Node.js 20+**
- **npm**, **yarn**, or **pnpm**

### Install dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
```

---

## Development

Run the development server (using Turbopack):

```bash
npm run dev
```

Then open your browser at  
[http://localhost:3000](http://localhost:3000)

The app will automatically reload as you edit files.

Main entry point:  
`src/app/page.tsx`

---

## Build and Production

### Build the project
```bash
npm run build
```

### Start the production server

for full availability of public endpoints during API call need to set variable APP_URL
```bash
export APP_URL=http://localhost:3000
```

```bash
npm start
```

The app will be served at [http://localhost:3000](http://localhost:3000)

---

## Run with Docker

### Build Docker image
```bash
docker build -t otc-openapi-schema-validator .
```

### Run container
```bash
docker run -p 3000:3000 otc-openapi-schema-validator
```

The app will be available at  
[http://localhost:3000](http://localhost:3000)

---

## Scripts

| Command         | Description                             |
|-----------------|-----------------------------------------|
| `npm run dev`   | Start development server with Turbopack |
| `npm run build` | Build Next.js app for production        |
| `npm start`     | Run the production server               |
| `npm run lint`  | Lint code using ESLint                  |

---

## Tech Stack

- **Next.js 16** (App Router and Pages API)
- **React 19**
- **TypeScript 5**
- **Tailwind CSS 4**
- **@telekom/scale-components**
- **CodeMirror** (YAML/JSON editors)
- **Axios** (API requests)
- **js-yaml**, **yaml**
- **jspdf**, **jspdf-autotable**, **jszip** (report generation)
- **react-markdown**, **marked** (documentation rendering)

---

## Validation Workspace

The Scale-based workspace keeps the YAML editor beside three independent panels:
**Issues**, **Rules**, and **Manual**. On narrow screens, use **Editor** and
**Results** to switch views. Switching panels preserves the current document,
selected rules, and manual review state.

Issues support search, severity filters, grouping by rule or line, and pages of
100 results. Use **Details** for the full message, click a line to navigate to
the source, or click a lint gutter marker to reveal its issue. Display filters
and pagination do not remove diagnostics from the editor or exported reports.

In **Rules**, search and severity filters only change visibility.
**Select filtered** adds visible rules to the current selection;
**Clear filtered** removes only visible rules. Manual review remains separate
from automatic validation and is saved locally in the browser.

UI exports include PDF and Robot Framework XML, plus submission to ReportPortal.
The XML report uses Robot Framework format, not JUnit format.

---

## API

Base URL (local): `http://localhost:3000`

All endpoints accept/return JSON unless noted. Body size limit: **10 MB**.

### POST `/api/validate`
Validate an OpenAPI spec (YAML/JSON) from **raw content** or a **path/URL**.

**Body**
```json
{
  "path": "string (url or server path)",
  "file_content": "string (raw YAML/JSON)",
  "manual_rules": ["RULE_ID", "…"],
  "auto_rules": ["RULE_ID", "…"],
  "exclude_manual_rules": ["RULE_ID", "…"],
  "exclude_auto_rules": ["RULE_ID", "…"],
  "ruleset": "string (default: \"default\")",
  "export": "xml | pdf",
  "out": "string (required only when export=pdf)"
}
```

**Behavior**
- If `file_content` is provided, it takes precedence.
- Swagger 2.0 and OpenAPI 3.0.x inputs are validated in their original structure. The original source text is used for diagnostics, without conversion or YAML reserialization.
- JSON validation and XML-export responses temporarily retain the deprecated `conversion: {"converted": false}` field for compatibility.
- Invalid specification syntax returns **400** with `error`, `diagnostics`, `conversion`, and `rules`. Such documents are not exported to ReportPortal. Validation findings, including format-version violations reported by selected rules, return **200** in `diagnostics`.
- If `path` is an **HTTP/HTTPS URL**, the API loads the document from that URL. Gitea URLs support `/:owner/:repo/src/:ref/path/to/file.yaml` and explicit `branch`, `tag`, or `commit` forms such as `/:owner/:repo/src/branch/:ref/path/to/file.yaml`.
- If `path` is a **server path**, the file is read from disk (if accessible to the server).
- `ruleset` directory is read from `public/rulesets/<ruleset>`; only auto‑rules with `status: implemented` are used.
- Rule catalogs load atomically: unreadable or malformed YAML, duplicate IDs, and invalid implemented function bindings produce an error instead of partial validation. The UI displays catalog errors; the validation API returns HTTP 500 for a broken server-side catalog. Rules explicitly marked `unsupported` are not executed.
- `export: "xml"` builds **Robot XML** and imports a launch to **ReportPortal** (defaults used in server: project `openapi`, dynamic launch name/description). Response includes the created launch payload.
- `export: "pdf"` requires `out`; without it the API returns **400**. With `out`, it currently returns **501** (use the UI PDF export instead).

The former POST `/api/convert` endpoint now returns **410 Gone** after authentication, with a migration message directing clients to `/api/validate`. Submit the original specification instead of requesting conversion.

**Success Response (default validation)**
```json
{
  "diagnostics": [
    {
      "source": "Rule RULE_ID - Rule title",
      "message": "…",
      "lineNumber": 42,
      "severity": "High",
      "from": 123,
      "to": 140
    }
  ],
  "conversion": { "converted": false },
  "rules": {
    "manual": [],
    "auto": [ { "id": "RULE_ID", "title": "Rule title" } ],
    "manual_total": 0,
    "auto_total": 1,
    "manual_selected": 0,
    "auto_selected": 1
  }
}
```

`from` and `to` are zero-based UTF-16 offsets in the submitted text; `to` is
exclusive. `lineNumber` is one-based. Severity labels are `Critical`, `High`,
`Medium`, and `Low`. Rule diagnostics identify their rule through `source`;
a separate `id` field is not guaranteed. The `manual` and `auto` arrays contain
the selected catalog entries, with additional rule metadata omitted above.
Totals describe the available rules; selected counts reflect include/exclude
filters. Omitting an include list or passing an empty one selects all available
rules before exclusions.

**Invalid specification syntax (HTTP 400)**

The response has the same `diagnostics`, `conversion`, and `rules` fields as
default validation, plus an `error` string. Source-related diagnostics use the
same position fields described above.

**Successful XML import (HTTP 200)**
```json
{
  "success": true,
  "launch": { "id": "launch-id" },
  "conversion": { "converted": false }
}
```

`launch` contains the ReportPortal import response; its fields depend on
ReportPortal. This response does not include the default `diagnostics` or `rules`
fields. Requesting XML export sends a report to ReportPortal, rather than
returning a downloadable XML file.

**Examples**

Validate an original Swagger 2.0 document:
```bash
curl -X POST http://localhost:3000/api/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "file_content": "swagger: \"2.0\"\ninfo:\n  title: Demo\n  version: 1.0.0\npaths: {}",
    "ruleset": "default"
  }'
```

Validate an original OpenAPI 3.0 document:
```bash
curl -X POST http://localhost:3000/api/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "file_content": "openapi: 3.0.3\ninfo:\n  title: Demo\n  version: 1.0.0\npaths: {}",
    "ruleset": "default"
  }'
```

Validate from internal Gitea URL:
```bash
curl -X POST http://localhost:3000/api/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "https://gitea.eco.example.com/docs/repo/src/branch/main/openapi/spec.yaml",
    "auto_rules": ["RULE_1", "RULE_2"]
  }'
```

Export Robot XML directly to ReportPortal:
```bash
curl -X POST http://localhost:3000/api/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "file_content": "<your YAML here>",
    "export": "xml"
  }'
```

Validate with excluded rules:
```bash
curl -X POST http://localhost:3000/api/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "file_content": "openapi: 3.0.3\ninfo:\n  title: Demo\n  version: 1.0.0\npaths: {}",
    "ruleset": "default",
    "exclude_auto_rules": ["COD-020-01-2507-2507-M", "BAS-090-01-2507-2507-M"]
  }'
```

---

### GET `/api/reportportal`
Fetch **launch details** by ID.

**Query params**
- `project` — ReportPortal project name
- `launchId` — the launch ID

**Example**
```bash
curl "http://localhost:3000/api/reportportal?project=openapi&launchId=12345"
```

---

### GET `/api/reportportal/clusters`
Fetch **all index clusters** for a launch.

**Query params**
- `project` — ReportPortal project name
- `launchId` — the launch ID

**Example**
```bash
curl "http://localhost:3000/api/reportportal/clusters?project=openapi&launchId=12345"
```

## Deployment

The app is optimized for deployment as a **standalone Next.js server**.  
The Dockerfile includes:
- Multi-stage build for smaller images
- Standalone Next.js output
- Production-ready configuration

Default port: **3000**

---

## License

[Apache License Version 2.0](LICENSE)
