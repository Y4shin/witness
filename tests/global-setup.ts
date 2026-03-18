/**
 * Playwright global setup — creates a fresh test.db with all migrations applied.
 * Runs once before all Playwright tests.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createClient } from '@libsql/client';

const DB_PATH = join(process.cwd(), 'tests', 'test.db');
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

export default async function globalSetup() {
	// Start with a clean slate on every run
	for (const suffix of ['', '-wal', '-shm']) {
		const p = DB_PATH + suffix;
		if (existsSync(p)) rmSync(p);
	}

	const client = createClient({ url: `file:${DB_PATH}` });
	try {
		const dirs = readdirSync(MIGRATIONS_DIR).sort();
		for (const dir of dirs) {
			const sqlPath = join(MIGRATIONS_DIR, dir, 'migration.sql');
			if (!existsSync(sqlPath)) continue;
			const sql = readFileSync(sqlPath, 'utf-8');
			const stripped = sql
				.split('\n')
				.filter((l) => !l.trim().startsWith('--'))
				.join('\n');
			for (const stmt of stripped
				.split(';')
				.map((s) => s.trim())
				.filter((s) => s.length > 0)) {
				await client.execute(stmt);
			}
		}
	} finally {
		client.close();
	}
}
