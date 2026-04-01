/**
 * Playwright global setup - creates fresh test databases with all migrations applied.
 * Runs once before all Playwright tests.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createClient } from '@libsql/client';

const DB_FILES = ['test.db', 'test-oidc.db'];
const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

async function resetDatabase(dbPath: string) {
	for (const suffix of ['', '-wal', '-shm']) {
		const path = dbPath + suffix;
		if (existsSync(path)) rmSync(path);
	}

	const client = createClient({ url: `file:${dbPath}` });
	try {
		const dirs = readdirSync(MIGRATIONS_DIR).sort();
		for (const dir of dirs) {
			const sqlPath = join(MIGRATIONS_DIR, dir, 'migration.sql');
			if (!existsSync(sqlPath)) continue;
			const sql = readFileSync(sqlPath, 'utf-8');
			const stripped = sql
				.split('\n')
				.filter((line) => !line.trim().startsWith('--'))
				.join('\n');

			for (const statement of stripped
				.split(';')
				.map((part) => part.trim())
				.filter((part) => part.length > 0)) {
				await client.execute(statement);
			}
		}
	} finally {
		client.close();
	}
}

export default async function globalSetup() {
	for (const filename of DB_FILES) {
		await resetDatabase(join(process.cwd(), 'tests', filename));
	}
}
