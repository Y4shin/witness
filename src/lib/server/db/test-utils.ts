import { readFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '$lib/server/prisma/client';

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../prisma/migrations'
);

export interface TestDb {
	db: PrismaClient;
	/** Call in afterEach to remove the temp database file. */
	cleanup: () => void;
}

/**
 * Creates an isolated PrismaClient backed by a temporary SQLite file.
 * Migrations are applied via @libsql/client directly before Prisma connects,
 * so DDL executes reliably outside the Prisma query engine.
 */
export async function createTestDb(): Promise<TestDb> {
	const dbPath = join(tmpdir(), `reporting-tool-test-${randomUUID()}.db`);
	const url = `file:${dbPath}`;

	// Apply migrations via the raw libsql client (Prisma's DDL path is unreliable)
	const migrationClient = createClient({ url });
	try {
		const migrationDirs = readdirSync(migrationsDir).sort();
		for (const dir of migrationDirs) {
			const sqlPath = join(migrationsDir, dir, 'migration.sql');
			try {
				const sql = readFileSync(sqlPath, 'utf-8');
				// Strip comment lines first, then split on semicolons.
				// Filtering on the chunk level would drop CREATE TABLE blocks that
				// are preceded by a "-- CreateTable" comment.
				const stripped = sql
					.split('\n')
					.filter((line) => !line.trim().startsWith('--'))
					.join('\n');
				const statements = stripped
					.split(';')
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				for (const statement of statements) {
					await migrationClient.execute(statement);
				}
			} catch (err: unknown) {
				const isNoEnt =
					err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
				if (!isNoEnt) throw err; // Re-throw unexpected errors
			}
		}
	} finally {
		migrationClient.close();
	}

	// Now create the Prisma client against the migrated file
	const adapter = new PrismaLibSql({ url });
	const db = new PrismaClient({ adapter });

	return {
		db,
		cleanup: () => {
			try {
				rmSync(dbPath);
			} catch {
				// Already removed — fine
			}
		}
	};
}
