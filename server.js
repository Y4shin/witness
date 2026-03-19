/**
 * Production server entry point.
 *
 * Loads OpenTelemetry instrumentation before SvelteKit starts so that the SDK
 * can patch Node internals (HTTP, fetch, etc.) in time.
 *
 * Usage:
 *   npm run start
 *
 * Which runs:
 *   node --import ./instrumentation.js ./build/index.js
 *
 * The instrumentation module is a no-op when OTEL_ENABLED != "true", so this
 * wrapper adds zero overhead in deployments that don't need telemetry.
 *
 * Do NOT run this file directly — use `npm run start` so that the
 * --import flag loads instrumentation.js before any app code.
 */
import './build/index.js';
