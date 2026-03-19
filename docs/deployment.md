# Deployment Guide

## Overview

The reporting tool is a SvelteKit application built with `@sveltejs/adapter-node`. It produces a standalone Node.js server bundle in `build/` that can be run on any Linux/macOS host with Node 20+.

---

## Requirements

| Requirement | Minimum version |
|---|---|
| Node.js | 20 LTS |
| npm | 10+ |
| Disk | 500 MB (app + database) |

---

## Build

```bash
# Install production + dev dependencies (needed for the build step)
npm install

# Generate Prisma client and Paraglide messages
npx prisma generate
npx @inlang/paraglide-js compile --project ./project.inlang

# Build the SvelteKit bundle
npm run build
```

The output is written to `build/`.

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values before starting the server.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | SQLite file path (`file:./reporting-tool.db`) or libsql/Turso URL |
| `ADMIN_PASSWORD` | Yes | — | Password for the `/admin` route |
| `SESSION_SECRET` | Yes | — | At least 32 random bytes (hex) used to sign session tokens |
| `OTEL_ENABLED` | No | `false` | Set `true` to activate OpenTelemetry |
| `OTEL_SERVICE_NAME` | No | `reporting-tool` | Service name in traces and logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP/HTTP collector URL (required when `OTEL_ENABLED=true`) |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` |
| `LOG_PRETTY` | No | `false` | Pretty-print logs (development only) |

---

## Database migration

Run migrations before starting the server (safe to run on every deploy — idempotent):

```bash
npx prisma migrate deploy
```

---

## Starting the server

The `start` script loads the OpenTelemetry instrumentation module before SvelteKit starts, which is required for OTEL to patch Node internals in time:

```bash
npm run start
```

This runs:

```
node --import ./instrumentation.js ./build/index.js
```

When `OTEL_ENABLED=false` (the default), the instrumentation module is a no-op and adds zero overhead.

The server listens on `PORT` (default `3000`) and `HOST` (default `0.0.0.0`).

---

## Uploads directory

Encrypted file attachments are stored under `uploads/` in the working directory. Ensure this directory is on a persistent volume if running inside a container.

---

## Production checklist

- [ ] `DATABASE_URL` points to a persistent volume, not a temporary filesystem
- [ ] `uploads/` is on a persistent volume
- [ ] `ADMIN_PASSWORD` is at least 16 characters and kept secret
- [ ] `SESSION_SECRET` is at least 32 random hex characters and kept secret
- [ ] HTTPS is terminated at a reverse proxy (nginx, Caddy, etc.) — the app does not handle TLS
- [ ] `LOG_PRETTY=false` in production (JSON output is required for log aggregators)
- [ ] `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` configured if you want telemetry

---

## Reverse proxy (nginx example)

```nginx
server {
    listen 443 ssl;
    server_name reporting.example.com;

    ssl_certificate     /etc/letsencrypt/live/reporting.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reporting.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Docker (optional)

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && \
    npx @inlang/paraglide-js compile --project ./project.inlang && \
    npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .
COPY --from=builder /app/prisma ./prisma
VOLUME ["/app/uploads", "/app/data"]
ENV DATABASE_URL=file:/app/data/reporting-tool.db
EXPOSE 3000
CMD ["npm", "run", "start"]
```
