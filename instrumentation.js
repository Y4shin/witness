/**
 * OpenTelemetry instrumentation — loaded via Node's --import flag before the
 * SvelteKit server bundle starts.
 *
 * When OTEL_ENABLED != "true" this module is a complete no-op.
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
				'@opentelemetry/instrumentation-fs': { enabled: false }
			})
		]
	});

	sdk.start();

	process.on('SIGTERM', () => {
		sdk.shutdown().finally(() => process.exit(0));
	});
}
