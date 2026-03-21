/**
 * Integration tests for GET /api/submissions/[id]/files/[fileId]
 *
 * Covers:
 *  - 401 when unauthenticated
 *  - 404 when file record does not exist
 *  - 404 when fileId belongs to a different submission (params.id mismatch)
 *  - 403 when file's submission belongs to a different project
 *  - 403 when a SUBMITTER requests a file from another member's submission
 *  - 500 when the file is not present on disk
 *  - 200 with correct raw bytes and headers for MODERATORs
 *  - 200 with correct raw bytes for a SUBMITTER accessing their own file
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '$lib/server/prisma/client';

// ── db injection via module mock ────────────────────────────────────────────
let _db: PrismaClient;
vi.mock('$lib/server/db', () => ({ get db() { return _db; } }));

const { GET } = await import('./+server');

// ── helpers ─────────────────────────────────────────────────────────────────

function makeModerator(projectId: string) {
	return { id: 'mod-1', projectId, role: 'MODERATOR' as const };
}


function makeEvent(
	params: Record<string, string>,
	locals: { member?: unknown }
) {
	return { params, locals } as Parameters<typeof GET>[0];
}

async function seedProject(db: PrismaClient) {
	return db.project.create({ data: { name: 'Test Project' } });
}

async function seedMember(db: PrismaClient, projectId: string) {
	return db.member.create({
		data: {
			projectId,
			signingPublicKey: `spk-${Math.random()}`,
			encryptionPublicKey: `epk-${Math.random()}`,
			encryptedName: 'enc-name',
			encryptedContact: 'enc-contact',
			role: 'SUBMITTER'
		}
	});
}

async function seedSubmission(db: PrismaClient, projectId: string, memberId: string) {
	return db.submission.create({
		data: {
			projectId,
			memberId,
			encryptedPayload: 'payload',
			encryptedKeyProject: '{}',
			encryptedKeyUser: '{}',
			submitterSignature: 'sig'
		}
	});
}

/** Creates a real file on disk and a DB record pointing to it. Returns both. */
async function seedFileOnDisk(
	db: PrismaClient,
	submissionId: string,
	bytes: Uint8Array,
	tmpDir: string
) {
	const filePath = join(tmpDir, `${randomUUID()}.enc`);
	await writeFile(filePath, bytes);

	const record = await db.submissionFile.create({
		data: {
			submissionId,
			fieldName: 'evidence',
			mimeType: 'image/jpeg',
			storagePath: filePath,
			encryptedKey: '{"k":"v"}',
			encryptedKeyUser: '{"u":"v"}',
			sizeBytes: bytes.length
		}
	});
	return { record, filePath };
}

/** Seeds a DB record whose storagePath points to a file that does NOT exist. */
async function seedFileWithMissingDisk(db: PrismaClient, submissionId: string) {
	return db.submissionFile.create({
		data: {
			submissionId,
			fieldName: 'evidence',
			mimeType: 'image/jpeg',
			storagePath: `/tmp/does-not-exist-${randomUUID()}.enc`,
			encryptedKey: '{"k":"v"}',
			encryptedKeyUser: '{"u":"v"}',
			sizeBytes: 100
		}
	});
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('GET /api/submissions/[id]/files/[fileId]', () => {
	let testDb: TestDb;
	let tmpDir: string;

	beforeEach(async () => {
		testDb = await createTestDb();
		_db = testDb.db;
		tmpDir = join(tmpdir(), `rt-file-test-${randomUUID()}`);
		await mkdir(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		testDb.cleanup();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('returns 401 when unauthenticated', async () => {
		const event = makeEvent({ id: 'any', fileId: 'any' }, { member: undefined });
		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
	});

	it('returns 403 when a SUBMITTER requests a file from another member\'s submission', async () => {
		const project = await seedProject(testDb.db);
		const owner = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, owner.id);
		const { record } = await seedFileOnDisk(
			testDb.db, submission.id, new Uint8Array([1, 2, 3]), tmpDir
		);

		// Different submitter — not the owner
		const other = await seedMember(testDb.db, project.id);
		const event = makeEvent(
			{ id: submission.id, fileId: record.id },
			{ member: { id: other.id, projectId: project.id, role: 'SUBMITTER' as const } }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 404 when file record does not exist', async () => {
		const project = await seedProject(testDb.db);
		const event = makeEvent(
			{ id: 'some-submission', fileId: 'nonexistent-file' },
			{ member: makeModerator(project.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 404 });
	});

	it('returns 404 when fileId belongs to a different submission than params.id', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub1 = await seedSubmission(testDb.db, project.id, member.id);
		const sub2 = await seedSubmission(testDb.db, project.id, member.id);

		// File belongs to sub1, but we pass sub2 as params.id
		const { record } = await seedFileOnDisk(
			testDb.db,
			sub1.id,
			new Uint8Array([1, 2, 3]),
			tmpDir
		);

		const event = makeEvent(
			{ id: sub2.id, fileId: record.id },
			{ member: makeModerator(project.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 404 });
	});

	it('returns 403 when file belongs to a submission in a different project', async () => {
		const project1 = await seedProject(testDb.db);
		const project2 = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project1.id);
		const submission = await seedSubmission(testDb.db, project1.id, member.id);

		const { record } = await seedFileOnDisk(
			testDb.db,
			submission.id,
			new Uint8Array([10, 20]),
			tmpDir
		);

		// Moderator is from project2, file is in project1
		const event = makeEvent(
			{ id: submission.id, fileId: record.id },
			{ member: makeModerator(project2.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 500 when the file is missing from disk', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);
		const record = await seedFileWithMissingDisk(testDb.db, submission.id);

		const event = makeEvent(
			{ id: submission.id, fileId: record.id },
			{ member: makeModerator(project.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 500 });
	});

	it('returns 200 with raw bytes and correct headers', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);

		const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
		const { record } = await seedFileOnDisk(testDb.db, submission.id, bytes, tmpDir);

		const event = makeEvent(
			{ id: submission.id, fileId: record.id },
			{ member: makeModerator(project.id) }
		);
		const res = await GET(event);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(res.headers.get('Content-Length')).toBe(String(bytes.length));

		const body = new Uint8Array(await res.arrayBuffer());
		expect(body).toEqual(bytes);
	});

	it('returns 200 for a SUBMITTER downloading their own file', async () => {
		const project = await seedProject(testDb.db);
		const owner = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, owner.id);
		const bytes = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
		const { record } = await seedFileOnDisk(testDb.db, submission.id, bytes, tmpDir);

		const event = makeEvent(
			{ id: submission.id, fileId: record.id },
			{ member: { id: owner.id, projectId: project.id, role: 'SUBMITTER' as const } }
		);
		const res = await GET(event);
		expect(res.status).toBe(200);
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body).toEqual(bytes);
	});

	it('returns the exact bytes stored on disk (not re-encoded)', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);

		// Simulate encrypted file: iv (12 bytes) + ciphertext (arbitrary)
		const iv = new Uint8Array(12).fill(0xab);
		const ciphertext = new Uint8Array(32).fill(0xcd);
		const combined = new Uint8Array(iv.length + ciphertext.length);
		combined.set(iv);
		combined.set(ciphertext, iv.length);

		const { record } = await seedFileOnDisk(testDb.db, submission.id, combined, tmpDir);
		const event = makeEvent(
			{ id: submission.id, fileId: record.id },
			{ member: makeModerator(project.id) }
		);
		const res = await GET(event);

		const returned = new Uint8Array(await res.arrayBuffer());
		expect(returned).toEqual(combined);
		expect(returned.slice(0, 12)).toEqual(iv);
		expect(returned.slice(12)).toEqual(ciphertext);
	});
});
