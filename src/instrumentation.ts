/**
 * OpenTelemetry instrumentation initialisation.
 *
 * This file must be loaded before any other server-side code so that the OTEL
 * SDK can patch Node internals (HTTP, fetch, etc.) in time.
 *
 * Production:  loaded via the --import flag in server.js (adapter-node wrapper)
 * Development: imported as a side-effect at the top of hooks.server.ts
 *
 * When OTEL_ENABLED is not "true" this module is a no-op — no packages are
 * loaded and no network connections are attempted.
 */

if (process.env.OTEL_ENABLED === 'true') {
	const { NodeSDK } = await import('@opentelemetry/sdk-node');
	const { getNodeAutoInstrumentations } = await import(
		'@opentelemetry/auto-instrumentations-node'
	);
	const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
	const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http');
	const { SimpleLogRecordProcessor } = await import('@opentelemetry/sdk-logs');

	const sdk = new NodeSDK({
		serviceName: process.env.OTEL_SERVICE_NAME ?? 'reporting-tool',
		traceExporter: new OTLPTraceExporter(),
		logRecordProcessor: new SimpleLogRecordProcessor(new OTLPLogExporter()),
		instrumentations: [
			getNodeAutoInstrumentations({
				// Disable noisy file-system instrumentation
				'@opentelemetry/instrumentation-fs': { enabled: false }
			})
		]
	});

	sdk.start();

	process.on('SIGTERM', () => {
		sdk.shutdown().finally(() => process.exit(0));
	});
}
