# Authorization & Authentication

This project supports **optional authentication and authorization** using **ZITADEL**.  
Authentication can be fully disabled via environment configuration and is designed to work for:

- UI users (browser)
- API consumers (Postman, Curl)
- Automation / CI (machine accounts)

---
## Environment variables
All mentioned variables below need to be set for proper functioning:
### Server-side flag (used in API, middleware, server components)
`ENABLE_AUTH=false`

### Used to sign/encrypt session cookies
`AUTH_SECRET=supperSecret+UNnf4WnoLz9=`

### Base URL of your app
`APP_URL=http://localhost:3000`

### ZITADEL OIDC issuer
`AUTH_ZITADEL_ISSUER=https://zitadel.some-service.com`

### Web app (OIDC) credentials
`AUTH_ZITADEL_ID=1234567890`

### Api app (Basic) credentials
`ZITADEL_INTROSPECTION_CLIENT_ID=1234567890`

`ZITADEL_INTROSPECTION_CLIENT_SECRET=supperSecret+UNnf4WnoLz9=`

`ZITADEL_X_INTERNAL_API_KEY=secret`

`ZITADEL_MACHINE_SECRET=supperSecret+UNnf4WnoLz9=`

`ZITADEL_MACHINE_ID=machine`

`ZITADEL_PROJECT_ID=1234567890`

## Enable / Disable Authentication

Authentication is **optional** and controlled by an environment variable.

```env
ENABLE_AUTH=true
```

- `ENABLE_AUTH=false`
  - UI is fully accessible
  - No login buttons are shown
  - API endpoints do not require authentication
- `ENABLE_AUTH=true`
  - UI pages require login
  - API endpoints require authentication
  - Machine tokens and external access are enforced

> ⚠️ Client-side UI checks use `ENABLE_AUTH`.  
> Any change requires restarting the Next.js server.

---

## UI Authentication (Browser)

### Flow
- Uses **Authorization Code + PKCE**
- Implemented via **NextAuth**
- Identity provider: **ZITADEL**

### Behavior
- When `ENABLE_AUTH=true`:
  - Visiting `/` redirects to `/api/auth/signin`
  - Logged-in users can access the UI
  - Logout fully clears the session
- When `ENABLE_AUTH=false`:
  - No authentication routes are used
  - No Sign In / Logout buttons are rendered

### UI Controls
- **Logout** button: shown only when auth is enabled and user is logged in

---

## API Authorization Model

### Design principles
- UI redirects are handled in **middleware**
- API routes never redirect
- API routes always return JSON errors (`401 Unauthorized`)
- Authorization logic lives **inside API handlers**

### Supported authentication methods
| Method                  | Use case                  |
|-------------------------|---------------------------|
| NextAuth session cookie | UI → API calls            |
| Bearer token            | External API, Postman, CI |

---

## API Protection Mechanism

All protected API routes use a shared helper:

```ts
requireApiAuth(req)
```

This function:
1. Skips auth entirely if `ENABLE_AUTH=false`
2. Checks for a valid NextAuth session (UI)
3. Checks for a Bearer token (API clients)

If authentication fails:
```json
{ "error": "Unauthorized" }
```

---

## Machine / Automation Access (CI)

### Purpose
Allows **fully automated access** to APIs without user interaction.

### Token Type
- **Opaque access tokens**
- Issued via **OAuth 2.0 Client Credentials**
- Backed by a **ZITADEL machine account**

---

## Machine Token Issuing Endpoint

### Endpoint
```
POST /api/token/machine
```

### Security
This endpoint is **heavily protected**:

1. Requires internal API key as header:
   ```
   X-Internal-Api-Key: <ZITADEL_X_INTERNAL_API_KEY>
   ```
2. Uses server-side stored:
   - `ZITADEL_MACHINE_ID`
   - `ZITADEL_MACHINE_SECRET`
3. Never exposes secrets to clients
4. Intended for CI / internal use only
5. Can be additionally protected by WAF / IP allowlist

### Environment variables
```env
ZITADEL_MACHINE_ID=...
ZITADEL_MACHINE_SECRET=...
ZITADEL_X_INTERNAL_API_KEY=...
ZITADEL_PROJECT_ID=...
```

---

## Machine Token Scope & Audience

When issuing machine tokens, the following scope is included:

```
urn:zitadel:iam:org:project:id:<PROJECT_ID>:aud
```

This ensures:
- The API application is included in the token audience
- ZITADEL introspection returns `active: true`

Without this scope, introspection will return:
```json
{ "active": false }
```

---

## Token Validation (API Side)

### Opaque Tokens
- Validated via:
  ```
  POST /oauth/v2/introspect
  ```
- Authentication method:
  - `client_secret_basic`
- Uses:
  - `ZITADEL_INTROSPECTION_CLIENT_ID`
  - `ZITADEL_INTROSPECTION_CLIENT_SECRET`

### Validation logic
- Token must return:
  ```json
  { "active": true }
  ```
- Otherwise, request is rejected

---

## Middleware Behavior

### What middleware does
- Protects **UI routes only**
- Redirects unauthenticated users to `/api/auth/signin`

### What middleware does NOT do
- Does not protect `/api/*`
- Does not return JSON errors
- Does not validate tokens

> API security is enforced inside API handlers.

---

## Recommended Production Hardening

- Enable WAF or IP allowlist for `/api/token/machine`
- Rotate `ZITADEL_X_INTERNAL_API_KEY` regularly

---

## Glossary

| Term          | Meaning                             |
|---------------|-------------------------------------|
| UI auth       | Browser-based login                 |
| Machine token | Token issued via client credentials |
| Opaque token  | Token validated via introspection   |
| Introspection | Server-side token validation        |
