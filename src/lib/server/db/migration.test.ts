/**
 * Migration correctness test for 20260329000000_encrypt_submission_metadata.
 *
 * Strategy:
 * 1. Create a fresh SQLite DB and apply all migrations EXCEPT the new one.
 * 2. Insert seed data in the old schema format (with type, archiveCandidateUrl,
 *    archiveUrl on Submission; mimeType on SubmissionFile).
 * 3. Apply the new migration.
 * 4. Assert post-migration state:
 *    - Legacy plaintext columns are preserved (just made nullable / kept as-is)
 *    - schemaVersion = 1 for all migrated rows
 *    - encryptedMeta column exists and is NULL for legacy rows
 *    - encryptedPayload is intact (byte-for-byte)
 *    - New rows can be inserted as schemaVersion=2 without plaintext columns
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createClient, type Client } from '@libsql/client';

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../prisma/migrations'
);

async function applyMigration(client: Client, sql: string): Promise<void> {
	const stripped = sql
		.split('\n')
		.filter((line) => !line.trim().startsWith('--'))
		.join('\n');
	const statements = stripped
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const stmt of statements) {
		await client.execute(stmt);
	}
}

async function createDbWithMigrationsUpTo(targetDir: string): Promise<{ client: Client; dbPath: string }> {
	const dbPath = join(tmpdir(), `migration-test-${randomUUID()}.db`);
	const url = `file:${dbPath}`;
	const client = createClient({ url });

	const allDirs = readdirSync(migrationsDir).sort();
	for (const dir of allDirs) {
		if (dir >= targetDir) break; // stop before the target migration
		const sqlPath = join(migrationsDir, dir, 'migration.sql');
		try {
			const sql = readFileSync(sqlPath, 'utf-8');
			await applyMigration(client, sql);
		} catch (err: unknown) {
			const isNoEnt =
				err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
			if (!isNoEnt) throw err;
		}
	}

	return { client, dbPath };
}

const MIGRATION_DIR = '20260329000000_encrypt_submission_metadata';

describe('migration: encrypt_submission_metadata', () => {
	it('preserves legacy plaintext columns and adds schemaVersion + encryptedMeta', async () => {
		const { client, dbPath } = await createDbWithMigrationsUpTo(MIGRATION_DIR);

		try {
			// ── Seed old-schema data ─────────────────────────────────────────────
			await client.execute(`
				INSERT INTO "Project" (id, name, "publicKey", "createdAt")
				VALUES ('proj-1', 'Test Project', NULL, CURRENT_TIMESTAMP)
			`);
			await client.execute(`
				INSERT INTO "Member" (id, "projectId", "signingPublicKey", "encryptionPublicKey",
					"encryptedName", "encryptedContact", role, "joinedAt")
				VALUES ('mem-1', 'proj-1', 'spk-1', 'epk-1', 'enc-name', 'enc-contact', 'SUBMITTER', CURRENT_TIMESTAMP)
			`);

			// Insert a submission with old plaintext columns
			const encPayload = 'encrypted-payload-data-abc123';
			await client.execute(`
				INSERT INTO "Submission" (id, "projectId", "memberId", type,
					"archiveCandidateUrl", "archiveUrl",
					"encryptedPayload", "encryptedKeyProject", "encryptedKeyUser",
					"submitterSignature", "createdAt")
				VALUES ('sub-1', 'proj-1', 'mem-1', 'WEBPAGE',
					'https://example.com', 'https://archive.ph/abc',
					'${encPayload}', 'enc-key-project', 'enc-key-user',
					'sig-abc', CURRENT_TIMESTAMP)
			`);

			// Insert a submission file with old mimeType column
			await client.execute(`
				INSERT INTO "SubmissionFile" (id, "submissionId", "fieldName", "mimeType",
					"storagePath", "encryptedKey", "encryptedKeyUser", "sizeBytes", "createdAt")
				VALUES ('file-1', 'sub-1', 'evidence', 'image/jpeg',
					'/data/file.enc', 'enc-file-key', 'enc-file-key-user', 12345, CURRENT_TIMESTAMP)
			`);

			// Verify pre-migration state
			const preCheck = await client.execute('SELECT type, "archiveCandidateUrl", "archiveUrl" FROM "Submission" WHERE id = ?', ['sub-1']);
			expect(preCheck.rows[0].type).toBe('WEBPAGE');
			expect(preCheck.rows[0].archiveCandidateUrl).toBe('https://example.com');
			expect(preCheck.rows[0].archiveUrl).toBe('https://archive.ph/abc');

			const preFileCheck = await client.execute('SELECT "mimeType" FROM "SubmissionFile" WHERE id = ?', ['file-1']);
			expect(preFileCheck.rows[0].mimeType).toBe('image/jpeg');

			// ── Apply the new migration ─────────────────────────────────────────
			const migrationSql = readFileSync(
				join(migrationsDir, MIGRATION_DIR, 'migration.sql'),
				'utf-8'
			);
			await applyMigration(client, migrationSql);

			// ── Assert post-migration state ─────────────────────────────────────

			// Row count preserved
			const subCount = await client.execute('SELECT COUNT(*) as n FROM "Submission"');
			expect(Number(subCount.rows[0].n)).toBe(1);

			const fileCount = await client.execute('SELECT COUNT(*) as n FROM "SubmissionFile"');
			expect(Number(fileCount.rows[0].n)).toBe(1);

			// encryptedPayload value preserved exactly
			const sub = await client.execute('SELECT "encryptedPayload" FROM "Submission" WHERE id = ?', ['sub-1']);
			expect(sub.rows[0].encryptedPayload).toBe(encPayload);

			// Legacy plaintext columns are still accessible (not dropped)
			const legacySub = await client.execute(
				'SELECT type, "archiveCandidateUrl", "archiveUrl" FROM "Submission" WHERE id = ?',
				['sub-1']
			);
			expect(legacySub.rows[0].type).toBe('WEBPAGE');
			expect(legacySub.rows[0].archiveCandidateUrl).toBe('https://example.com');
			expect(legacySub.rows[0].archiveUrl).toBe('https://archive.ph/abc');

			// schemaVersion = 1 for migrated rows
			const schemaVersionSub = await client.execute('SELECT "schemaVersion" FROM "Submission" WHERE id = ?', ['sub-1']);
			expect(Number(schemaVersionSub.rows[0].schemaVersion)).toBe(1);

			const schemaVersionFile = await client.execute('SELECT "schemaVersion" FROM "SubmissionFile" WHERE id = ?', ['file-1']);
			expect(Number(schemaVersionFile.rows[0].schemaVersion)).toBe(1);

			// mimeType column still accessible on SubmissionFile
			const legacyFile = await client.execute('SELECT "mimeType" FROM "SubmissionFile" WHERE id = ?', ['file-1']);
			expect(legacyFile.rows[0].mimeType).toBe('image/jpeg');

			// encryptedMeta column exists and is NULL for the legacy row
			const fileRow = await client.execute('SELECT "encryptedMeta" FROM "SubmissionFile" WHERE id = ?', ['file-1']);
			expect(fileRow.rows[0].encryptedMeta).toBeNull();

			// New rows can be inserted as schemaVersion=2 with encryptedMeta and without mimeType
			await client.execute(`
				INSERT INTO "SubmissionFile" (id, "submissionId", "fieldName",
					"schemaVersion", "encryptedMeta",
					"storagePath", "encryptedKey", "encryptedKeyUser", "sizeBytes", "createdAt")
				VALUES ('file-2', 'sub-1', 'evidence',
					2, 'encrypted-meta-string',
					'/data/file2.enc', 'enc-file-key-2', 'enc-file-key-user-2', 999, CURRENT_TIMESTAMP)
			`);
			const newFileRow = await client.execute('SELECT "encryptedMeta", "schemaVersion" FROM "SubmissionFile" WHERE id = ?', ['file-2']);
			expect(newFileRow.rows[0].encryptedMeta).toBe('encrypted-meta-string');
			expect(Number(newFileRow.rows[0].schemaVersion)).toBe(2);

			// New Submission rows can be inserted as schemaVersion=2 without type/archiveUrl
			await client.execute(`
				INSERT INTO "Submission" (id, "projectId", "memberId",
					"schemaVersion",
					"encryptedPayload", "encryptedKeyProject", "encryptedKeyUser",
					"submitterSignature", "createdAt")
				VALUES ('sub-2', 'proj-1', 'mem-1',
					2,
					'new-encrypted-payload', 'enc-key-proj-2', 'enc-key-user-2',
					'sig-2', CURRENT_TIMESTAMP)
			`);
			const newSub = await client.execute(
				'SELECT "encryptedPayload", "schemaVersion", type FROM "Submission" WHERE id = ?',
				['sub-2']
			);
			expect(newSub.rows[0].encryptedPayload).toBe('new-encrypted-payload');
			expect(Number(newSub.rows[0].schemaVersion)).toBe(2);
			expect(newSub.rows[0].type).toBeNull();

			// Server-side migration endpoint semantics: clearing plaintext columns on promote
			await client.execute(`
				UPDATE "Submission"
				SET type = NULL, "archiveCandidateUrl" = NULL, "archiveUrl" = NULL, "schemaVersion" = 2,
				    "encryptedPayload" = 'migrated-payload'
				WHERE id = 'sub-1'
			`);
			const migratedSub = await client.execute(
				'SELECT type, "archiveUrl", "schemaVersion", "encryptedPayload" FROM "Submission" WHERE id = ?',
				['sub-1']
			);
			expect(migratedSub.rows[0].type).toBeNull();
			expect(migratedSub.rows[0].archiveUrl).toBeNull();
			expect(Number(migratedSub.rows[0].schemaVersion)).toBe(2);
			expect(migratedSub.rows[0].encryptedPayload).toBe('migrated-payload');

		} finally {
			client.close();
			try { rmSync(dbPath); } catch { /* ignore */ }
		}
	});
});
