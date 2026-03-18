# Observability

## Stack

| Package | Role |
|---|---|
| `pino` | Structured logger — KV-argument style, JSON output |
| `pino-pretty` (dev only) | Human-readable log formatting for development |
| `pino-opentelemetry-transport` | Forwards Pino logs into the OpenTelemetry log signal |
| `@opentelemetry/sdk-node` | Node.js OpenTelemetry SDK |
| `@opentelemetry/auto-instrumentations-node` | Auto-instruments HTTP, fetch, and other I/O |
| `@opentelemetry/exporter-otlp-http` | OTLP/HTTP exporter for traces, metrics, and logs |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OTEL_ENABLED` | `false` | Master switch. `true` enables all telemetry signals. |
| `OTEL_SERVICE_NAME` | `reporting-tool` | Service name attached to all traces and logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(none)_ | OTLP collector URL, e.g. `http://otel-collector:4318` |
| `LOG_LEVEL` | `info` | Pino log level: `trace` / `debug` / `info` / `warn` / `error` |
| `LOG_PRETTY` | `false` | Enable `pino-pretty` (development only — do not use in production) |

## Architecture

### Initialisation order
OpenTelemetry must be registered before any other imports to correctly patch Node internals. This is achieved by:

1. Building a `src/instrumentation.ts` file that calls `NodeSDK.start()` conditionally on `OTEL_ENABLED`.
2. Loading it via the `--import` flag in the production start script (`server.js`) that wraps `adapter-node`'s output.
3. In development (`vite dev`), import `src/instrumentation.ts` at the top of `hooks.server.ts` as a side-effect import.

### Logger (`src/lib/server/logger.ts`)
A Pino singleton exported for use throughout server-side code. Behaviour depends on environment:

- `OTEL_ENABLED=false`, `LOG_PRETTY=false`: JSON to stdout (production default without telemetry)
- `OTEL_ENABLED=false`, `LOG_PRETTY=true`: pretty-printed to stdout (development)
- `OTEL_ENABLED=true`: JSON to stdout **and** forwarded to OpenTelemetry log signal via `pino-opentelemetry-transport`

## Logging conventions

All log calls must use the KV-argument form — structured, not interpolated:

```ts
// Correct
logger.info({ userId: user.id, projectId, role }, 'User joined project')
logger.warn({ token, reason: 'expired' }, 'Invite link rejected')
logger.error({ err, userId }, 'Challenge verification failed')

// Wrong — unstructured, unsearchable
logger.info(`User ${userId} joined project ${projectId}`)
```

### Standard fields
Include these fields where applicable so logs are correlatable across services:

| Field | Type | When to include |
|---|---|---|
| `userId` | string | Any operation involving an authenticated user |
| `projectId` | string | Any project-scoped operation |
| `submissionId` | string | Submission operations |
| `role` | string | Membership changes |
| `err` | Error | All `error` and `warn` level logs for exceptions |
| `token` | string | Invite link operations (log the token, not the full URL) |

### What NOT to log
- Private keys (ever, under any circumstances)
- Plaintext submission content (server never sees it — but guard against accidental logging)
- Passphrases
- Full session tokens (log a truncated hash if correlation is needed)

## OpenTelemetry signals

| Signal | Enabled when | Notes |
|---|---|---|
| **Traces** | `OTEL_ENABLED=true` | Auto-instrumented HTTP spans via `auto-instrumentations-node` |
| **Logs** | `OTEL_ENABLED=true` | All Pino output forwarded via `pino-opentelemetry-transport` |
| **Metrics** | `OTEL_ENABLED=true` | Basic Node.js runtime metrics from `auto-instrumentations-node` |

When `OTEL_ENABLED=false`, no network connections to any collector are attempted and the SDK is not initialised — zero overhead.
