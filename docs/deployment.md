# Deployment Guide

## Overview

The reporting tool is a SvelteKit application built with `@sveltejs/adapter-node`. It produces a standalone Node.js server bundle in `build/` that can be run on any Linux/macOS host with Node 20+.

## Requirements

| Requirement | Minimum version |
| ----------- | --------------- |
| Node.js     | 20 LTS          |
| npm         | 10+             |
| Disk        | 500 MB          |

## Build

```bash
npm install
npx prisma generate
npx @inlang/paraglide-js compile --project ./project.inlang
npm run build
```

The output is written to `build/`.

## Environment variables

Copy `.env.example` to `.env` and fill in the values before starting the server.

| Variable                      | Required                         | Description                                                                   |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `ORIGIN`                      | Yes                              | Public origin for CSRF protection, absolute redirects, and OIDC callback URLs |
| `DATABASE_URL`                | Yes                              | SQLite file path (`file:./reporting-tool.db`) or libsql/Turso URL             |
| `SESSION_SECRET`              | Yes                              | At least 32 random bytes (hex) used to sign session tokens                    |
| `ADMIN_AUTH_MODE`             | Yes                              | `password` or `oidc`                                                          |
| `ADMIN_PASSWORD`              | Password mode only               | Password for `/admin`                                                         |
| `ADMIN_OIDC_DISCOVERY_URL`    | OIDC mode only                   | Provider discovery root or well-known URL                                     |
| `ADMIN_OIDC_CLIENT_ID`        | OIDC mode only                   | OAuth/OIDC client ID                                                          |
| `ADMIN_OIDC_CLIENT_SECRET`    | OIDC mode only                   | OAuth/OIDC client secret                                                      |
| `ADMIN_OIDC_SCOPES`           | No                               | Defaults to `openid profile email`                                            |
| `ADMIN_OIDC_ALLOWED_EMAILS`   | OIDC mode: one of three required | Comma-separated allow-list of admin email addresses                           |
| `ADMIN_OIDC_ALLOWED_SUBJECTS` | OIDC mode: one of three required | Comma-separated allow-list of `sub` claim values                              |
| `ADMIN_OIDC_ALLOWED_GROUPS`   | OIDC mode: one of three required | Comma-separated allow-list of OIDC `groups` claim values                      |
| `OTEL_ENABLED`                | No                               | Set `true` to activate OpenTelemetry                                          |
| `OTEL_SERVICE_NAME`           | No                               | Service name in traces and logs                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No                               | OTLP/HTTP collector URL (required when `OTEL_ENABLED=true`)                   |
| `LOG_LEVEL`                   | No                               | Pino log level                                                                |
| `LOG_PRETTY`                  | No                               | Pretty-print logs (development only)                                          |

Admin auth modes are mutually exclusive. Do not set both `ADMIN_PASSWORD` and `ADMIN_OIDC_*` values at the same time.

## Database migration

Run migrations before starting the server:

```bash
npx prisma migrate deploy
```

## Starting the server

```bash
npm run start
```

This runs:

```bash
node --import ./instrumentation.js ./build/index.js
```

The server listens on `PORT` (default `3000`) and `HOST` (default `0.0.0.0`).

## Uploads directory

Encrypted file attachments are stored under `uploads/` in the working directory. Ensure this directory is on a persistent volume if running inside a container.

## Local OIDC testing with Authentik

The repository Docker Compose file now includes an optional Authentik stack behind the `oidc` profile.

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_AUTH_MODE=oidc`.
3. Leave `ADMIN_PASSWORD` empty.
4. Set `ORIGIN=http://localhost:3000`.
5. Pick secure values for `AUTHENTIK_POSTGRES_PASSWORD`, `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_BOOTSTRAP_PASSWORD`, and `AUTHENTIK_BOOTSTRAP_TOKEN`.
6. Start the stack with `docker compose --profile oidc up --build`.
7. Sign in to Authentik at `http://localhost:9000/if/admin/` with `AUTHENTIK_BOOTSTRAP_EMAIL` and `AUTHENTIK_BOOTSTRAP_PASSWORD`.
8. Create an OAuth2/OpenID Connect provider and application for the reporting tool.
9. Register `http://localhost:3000/admin/login/oidc/callback` as the redirect URI.
10. Set:

```bash
ADMIN_OIDC_DISCOVERY_URL=http://localhost:9000/application/o/reporting-tool/
ADMIN_OIDC_CLIENT_ID=<client id from authentik>
ADMIN_OIDC_CLIENT_SECRET=<client secret from authentik>
ADMIN_OIDC_ALLOWED_GROUPS=reporting-tool-admin-access
```

11. Restart the app container if you changed `.env`.
12. Visit `http://localhost:3000/admin/login` and complete the OIDC flow.

If you use group-based authorization, ensure the provider exposes a `groups` claim in the
ID token or userinfo response.

## Production checklist

- `DATABASE_URL` points to persistent storage
- `uploads/` is on persistent storage
- `SESSION_SECRET` is random and kept secret
- Password mode: `ADMIN_PASSWORD` is at least 16 characters and kept secret
- OIDC mode: the client is confidential and restricted to admin identities
- OIDC mode: at least one of `ADMIN_OIDC_ALLOWED_EMAILS`, `ADMIN_OIDC_ALLOWED_SUBJECTS`, or `ADMIN_OIDC_ALLOWED_GROUPS` is set
- HTTPS is terminated at a reverse proxy
- `LOG_PRETTY=false` in production
- `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` configured if you want telemetry
