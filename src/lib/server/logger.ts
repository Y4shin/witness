import pino from 'pino';
import type { Logger, TransportTargetOptions } from 'pino';

export type { Logger };

/** Exported for testing — do not call directly in application code. */
export function buildTransportTargets(env: NodeJS.ProcessEnv = process.env): TransportTargetOptions[] {
	const level = env.LOG_LEVEL ?? 'info';
	const otelEnabled = env.OTEL_ENABLED === 'true';
	const logPretty = env.LOG_PRETTY === 'true';

	const targets: TransportTargetOptions[] = [
		logPretty
			? { target: 'pino-pretty', level, options: { colorize: true } }
			: { target: 'pino/file', level, options: { destination: 1 } } // fd 1 = stdout
	];

	if (otelEnabled) {
		targets.push({ target: 'pino-opentelemetry-transport', level });
	}

	return targets;
}

/**
 * Application-wide structured logger.
 *
 * Use the KV-argument form for all calls:
 *   logger.info({ userId, projectId }, 'User joined project')
 *   logger.error({ err, userId }, 'Challenge verification failed')
 *
 * Never log private keys, plaintext submission content, passphrases,
 * or full session tokens.
 *
 * Behaviour is controlled by environment variables:
 *   LOG_LEVEL      - pino log level (default: 'info')
 *   LOG_PRETTY     - enable pino-pretty for development (default: false)
 *   OTEL_ENABLED   - also forward logs to OpenTelemetry (default: false)
 */
function buildTransport() {
	const targets = buildTransportTargets();
	return pino.transport(targets.length === 1 ? targets[0] : { targets });
}

export const logger: Logger = pino(
	{ level: process.env.LOG_LEVEL ?? 'info' },
	buildTransport()
);
