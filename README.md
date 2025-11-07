# OTC OpenAPI Schema Validator

A web-based tool built with **Next.js 15**, **React 19**, and **Tailwind CSS 4** for validating and visualizing OpenAPI schemas (YAML/JSON).  
It supports file uploads, URL-based loading (including Internal Gitea-hosted specs), and provides detailed diagnostics and reports.

---

## Getting Started

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
`app/page.tsx`

---

## Build and Production

### Build the project
```bash
npm run build
```

### Start the production server
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

- **Next.js 15** (App Router)
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
  "ruleset": "string (default: \"default\")",
  "export": "xml | pdf",
  "out": "string (required only when export=pdf)"
}
```

**Behavior**
- If `file_content` is provided, it takes precedence.
- If `path` is an **HTTP/HTTPS URL**. For Gitea URL, expected next shape: `/:owner/:repo/src/:branch/path/to/file.yaml`.
- If `path` is a **server path**, the file is read from disk (if accessible to the server).
- `ruleset` directory is read from `public/rulesets/<ruleset>`; only auto‑rules with `status: implemented` are used.
- `export: "xml"` builds **Robot XML** and imports a launch to **ReportPortal** (defaults used in server: project `openapi`, dynamic launch name/description). Response includes the created launch payload.
- `export: "pdf"` currently returns **501** (use the UI export instead).

**Success Response (default validation)**
```json
{
  "diagnostics": [
    { "id": "RULE_ID", "message": "…", "lineNumber": 42, "severity": "High", "from": 123, "to": 140 }
  ],
  "rules": {
    "manual": [ { "id": "…" } ],
    "auto": [ { "id": "…" } ],
    "manual_total": 0,
    "auto_total": 0,
    "manual_selected": 0,
    "auto_selected": 0
  }
}
```

**Examples**

Validate with raw content:
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
    "path": "https://gitea.my-service.com/owner/repo/src/main/specs/openapi.yaml",
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
