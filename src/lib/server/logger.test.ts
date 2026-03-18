import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { buildTransportTargets } from './logger';

// Helper: create a logger writing to an in-memory array so we can assert on
// structured output without spawning worker threads or touching stdout.
function createTestLogger(levelOverride?: string) {
	const lines: string[] = [];
	const stream = {
		write(chunk: string) {
			lines.push(chunk.trim());
		}
	};
	const level = levelOverride ?? 'info';
	const instance = pino({ level }, stream as unknown as ReturnType<typeof pino.destination>);
	return { instance, lines };
}

describe('logger — structured output', () => {
	it('emits a JSON object with required fields for info', () => {
		const { instance, lines } = createTestLogger();
		instance.info({ userId: 'u1', projectId: 'p1' }, 'User joined project');

		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record).toMatchObject({
			level: 30, // pino numeric level for 'info'
			msg: 'User joined project',
			userId: 'u1',
			projectId: 'p1'
		});
		expect(typeof record.time).toBe('number');
	});

	it('includes err.message for warn logs with an Error object', () => {
		const { instance, lines } = createTestLogger();
		instance.warn({ err: new Error('something went wrong'), userId: 'u2' }, 'Challenge failed');

		const record = JSON.parse(lines[0]);
		expect(record.level).toBe(40); // warn
		expect(record.err.message).toBe('something went wrong');
		expect(record.userId).toBe('u2');
	});

	it('uses numeric level 50 for error', () => {
		const { instance, lines } = createTestLogger();
		instance.error({ err: new Error('fatal') }, 'Unhandled error');

		expect(JSON.parse(lines[0]).level).toBe(50);
	});
});

describe('logger — level filtering', () => {
	it('suppresses debug logs when level is info', () => {
		const { instance, lines } = createTestLogger('info');
		instance.debug({ x: 1 }, 'debug message');

		expect(lines).toHaveLength(0);
	});

	it('emits debug logs when level is debug', () => {
		const { instance, lines } = createTestLogger('debug');
		instance.debug({ x: 1 }, 'debug message');

		expect(lines).toHaveLength(1);
	});

	it('only emits warn and above when level is warn', () => {
		const { instance, lines } = createTestLogger('warn');
		instance.debug('debug');
		instance.info('info');
		instance.warn('warn');
		instance.error('error');

		expect(lines).toHaveLength(2);
		const levels = lines.map((l) => JSON.parse(l).level);
		expect(levels).toEqual([40, 50]); // warn, error
	});
});

describe('buildTransportTargets — OTEL guard', () => {
	it('does not include pino-opentelemetry-transport when OTEL_ENABLED is unset', () => {
		const targets = buildTransportTargets({ LOG_LEVEL: 'info' });

		const targetNames = targets.map((t) => t.target);
		expect(targetNames).not.toContain('pino-opentelemetry-transport');
	});

	it('does not include pino-opentelemetry-transport when OTEL_ENABLED=false', () => {
		const targets = buildTransportTargets({ OTEL_ENABLED: 'false', LOG_LEVEL: 'info' });

		const targetNames = targets.map((t) => t.target);
		expect(targetNames).not.toContain('pino-opentelemetry-transport');
	});

	it('includes pino-opentelemetry-transport when OTEL_ENABLED=true', () => {
		const targets = buildTransportTargets({ OTEL_ENABLED: 'true', LOG_LEVEL: 'info' });

		const targetNames = targets.map((t) => t.target);
		expect(targetNames).toContain('pino-opentelemetry-transport');
	});

	it('uses pino-pretty when LOG_PRETTY=true', () => {
		const targets = buildTransportTargets({ LOG_PRETTY: 'true', LOG_LEVEL: 'info' });

		expect(targets[0].target).toBe('pino-pretty');
	});

	it('uses pino/file (stdout) when LOG_PRETTY is unset', () => {
		const targets = buildTransportTargets({ LOG_LEVEL: 'info' });

		expect(targets[0].target).toBe('pino/file');
	});

	it('passes the log level to each transport target', () => {
		const targets = buildTransportTargets({ LOG_LEVEL: 'warn', OTEL_ENABLED: 'true' });

		for (const t of targets) {
			expect(t.level).toBe('warn');
		}
	});
});
