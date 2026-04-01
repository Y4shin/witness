# Reporting Tool

Encrypted reporting application built with SvelteKit. The app has two separate authentication systems:

- project member auth for reporters and moderators
- admin auth for the `/admin` console

The admin console can run in exactly one mode:

- password mode via `ADMIN_PASSWORD`
- OIDC mode via `ADMIN_OIDC_*`

Do not configure both at the same time.

## Development

```bash
npm install
npm run dev
```

The default dev server runs on `http://localhost:5173`.

## Build

```bash
npm run build
npm run start
```

## Environment

Copy `.env.example` to `.env` and fill in the values you need.

Core variables:

- `ORIGIN`: public origin of the app, used for CSRF and absolute redirects
- `DATABASE_URL`: SQLite path or libsql/Turso URL
- `SESSION_SECRET`: at least 32 random bytes in hex
- `ADMIN_AUTH_MODE`: `password` or `oidc`

Password admin mode:

- `ADMIN_PASSWORD`

OIDC admin mode:

- `ADMIN_OIDC_DISCOVERY_URL`
- `ADMIN_OIDC_CLIENT_ID`
- `ADMIN_OIDC_CLIENT_SECRET`
- `ADMIN_OIDC_SCOPES`
- `ADMIN_OIDC_ALLOWED_EMAILS`
- `ADMIN_OIDC_ALLOWED_SUBJECTS`

In OIDC mode, at least one of `ADMIN_OIDC_ALLOWED_EMAILS` or `ADMIN_OIDC_ALLOWED_SUBJECTS` must be set.

## Admin OIDC Setup

This is the quickest production-oriented checklist for another agent or operator to follow.

### 1. Pick the public URL

Decide the final external origin first. Example:

```bash
ORIGIN=https://reports.example.com
```

The admin callback URL will then be:

```text
https://reports.example.com/admin/login/oidc/callback
```

### 2. Switch the app to OIDC mode

Set these env vars on the server:

```bash
ADMIN_AUTH_MODE=oidc
ADMIN_PASSWORD=
ADMIN_OIDC_DISCOVERY_URL=https://auth.example.com/application/o/reporting-tool/
ADMIN_OIDC_CLIENT_ID=replace-me
ADMIN_OIDC_CLIENT_SECRET=replace-me
ADMIN_OIDC_SCOPES=openid profile email
ADMIN_OIDC_ALLOWED_EMAILS=admin1@example.com,admin2@example.com
# or
# ADMIN_OIDC_ALLOWED_SUBJECTS=uuid-or-subject-1,uuid-or-subject-2
```

Important:

- leave `ADMIN_PASSWORD` empty in OIDC mode
- do not set both password and OIDC config
- `ADMIN_OIDC_DISCOVERY_URL` may be a discovery root or a full `/.well-known/openid-configuration` URL
- the configured OIDC client should be confidential and use the authorization code flow

### 3. Create the OIDC client in your provider

The app expects a standard OpenID Connect authorization code client with:

- redirect URI: `https://reports.example.com/admin/login/oidc/callback`
- scopes: `openid profile email`
- client authentication: client secret

The app verifies:

- issuer and audience from the provider metadata and client ID
- PKCE state and nonce round-trips
- ID token signature via provider JWKS
- allow-list match on email and/or `sub`

### 4. Restrict who can log into `/admin`

Use one or both of:

- `ADMIN_OIDC_ALLOWED_EMAILS`
- `ADMIN_OIDC_ALLOWED_SUBJECTS`

Recommendations:

- prefer `ADMIN_OIDC_ALLOWED_SUBJECTS` if your identity system gives stable subject identifiers
- use `ADMIN_OIDC_ALLOWED_EMAILS` only for verified admin accounts
- keep the list short and explicit

### 5. Restart the app and verify login

After changing env vars:

```bash
npm run build
npm run start
```

Then verify:

1. Open `/admin/login`
2. Confirm the page shows the OIDC sign-in button instead of the password form
3. Complete the provider login
4. Confirm you land on `/admin`

## Authentik Example

If you are using Authentik, a typical setup looks like this:

1. Create an OAuth2/OpenID Connect provider in Authentik.
2. Create an application bound to that provider.
3. Set the redirect URI to:
   `https://reports.example.com/admin/login/oidc/callback`
4. Copy the Authentik client ID and client secret into the app env.
5. Set discovery URL to the application endpoint:

```bash
ADMIN_OIDC_DISCOVERY_URL=https://auth.example.com/application/o/reporting-tool/
```

Depending on your Authentik slug, the final path segment may differ from `reporting-tool`.

## Local Authentik Testing

The repository includes an optional Authentik stack in `docker-compose.yml`.

```bash
docker compose --profile oidc up --build
```

That stack is intended for local verification and manual testing, not for production.

## E2E OIDC Tests

The Playwright suite includes admin OIDC integration tests against a throwaway `oidc-provider` instance. Run:

```bash
npx playwright test tests/admin-oidc.e2e.ts --project oidc-admin
```

## Deployment Notes

For fuller deployment guidance, see [docs/deployment.md](/docs/deployment.md).

Production reminders:

- terminate HTTPS in front of the app
- keep `SESSION_SECRET` and OIDC client secrets out of source control
- store the database and `uploads/` on persistent storage
- keep `LOG_PRETTY=false` in production
