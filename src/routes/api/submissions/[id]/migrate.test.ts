/**
 * Integration tests for:
 *   PATCH /api/submissions/[id]/migrate
 *   PATCH /api/submissions/[id]/files/[fileId]/migrate
 *
 * Covers:
 *  - 401 when unauthenticated
 *  - 404 when resource not found
 *  - 403 when submission belongs to a different project or different member
 *  - 400 when required fields are missing
 *  - 200 happy path: submission promoted to schemaVersion=2, plaintext columns cleared
 *  - 200 idempotent: calling again on an already-v2 record returns ok:true
 *  - 200 file happy path: file promoted to schemaVersion=2, mimeType cleared
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';
import type { PrismaClient } from '$lib/server/prisma/client';

// ── db injection via module mock ─────────────────────────────────────────────
let _db: PrismaClient;
vi.mock('$lib/server/db', () => ({ get db() { return _db; } }));

const { PATCH: migrateSubmission } = await import('./migrate/+server');
const { PATCH: migrateFile } = await import('./files/[fileId]/migrate/+server');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeModerator(projectId: string, memberId = 'mod-1') {
	return { id: memberId, projectId, role: 'MODERATOR' as const };
}

function makeSubmitter(projectId: string, memberId = 'sub-1') {
	return { id: memberId, projectId, role: 'SUBMITTER' as const };
}

function makeRequest(body: unknown) {
	return { json: () => Promise.resolve(body) } as Request;
}

function makeSubEvent(params: Record<string, string>, locals: { member?: unknown }, body: unknown = {}) {
	return { params, locals, request: makeRequest(body) } as Parameters<typeof migrateSubmission>[0];
}

function makeFileEvent(params: Record<string, string>, locals: { member?: unknown }, body: unknown = {}) {
	return { params, locals, request: makeRequest(body) } as Parameters<typeof migrateFile>[0];
}

async function seedProject(db: PrismaClient) {
	return db.project.create({ data: { name: 'Test Project' } });
}

async function seedMember(db: PrismaClient, projectId: string, role: 'SUBMITTER' | 'MODERATOR' = 'SUBMITTER') {
	return db.member.create({
		data: {
			projectId,
			signingPublicKey: `spk-${Math.random()}`,
			encryptionPublicKey: `epk-${Math.random()}`,
			encryptedName: 'enc-name',
			encryptedContact: 'enc-contact',
			role
		}
	});
}

async function seedV1Submission(db: PrismaClient, projectId: string, memberId: string) {
	return db.submission.create({
		data: {
			projectId,
			memberId,
			type: 'WEBPAGE',
			archiveCandidateUrl: 'https://example.com',
			archiveUrl: 'https://archive.ph/abc',
			schemaVersion: 1,
			encryptedPayload: 'old-payload',
			encryptedKeyProject: '{"old":"proj"}',
			encryptedKeyUser: '{"old":"user"}',
			submitterSignature: 'sig'
		}
	});
}

async function seedV1File(db: PrismaClient, submissionId: string) {
	return db.submissionFile.create({
		data: {
			submissionId,
			fieldName: 'evidence',
			mimeType: 'image/jpeg',
			schemaVersion: 1,
			encryptedMeta: null,
			storagePath: '/dev/null',
			encryptedKey: '{"k":"proj"}',
			encryptedKeyUser: '{"k":"user"}',
			sizeBytes: 100
		}
	});
}

// ── submission migrate tests ──────────────────────────────────────────────────

describe('PATCH /api/submissions/[id]/migrate', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
		_db = testDb.db;
	});

	afterEach(() => { testDb.cleanup(); });

	it('returns 401 when unauthenticated', async () => {
		const event = makeSubEvent({ id: 'any' }, { member: undefined }, {});
		await expect(migrateSubmission(event)).rejects.toMatchObject({ status: 401 });
	});

	it('returns 404 when submission does not exist', async () => {
		const project = await seedProject(testDb.db);
		const event = makeSubEvent(
			{ id: 'nonexistent' },
			{ member: makeModerator(project.id) },
			{ encryptedPayload: 'p', encryptedKeyProject: 'k', encryptedKeyUser: 'u' }
		);
		await expect(migrateSubmission(event)).rejects.toMatchObject({ status: 404 });
	});

	it('returns 403 when submission belongs to a different project', async () => {
		const proj1 = await seedProject(testDb.db);
		const proj2 = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, proj1.id);
		const sub = await seedV1Submission(testDb.db, proj1.id, member.id);

		const event = makeSubEvent(
			{ id: sub.id },
			{ member: makeModerator(proj2.id) },
			{ encryptedPayload: 'p', encryptedKeyProject: 'k', encryptedKeyUser: 'u' }
		);
		await expect(migrateSubmission(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 403 when a SUBMITTER tries to migrate another member\'s submission', async () => {
		const project = await seedProject(testDb.db);
		const owner = await seedMember(testDb.db, project.id);
		const other = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, owner.id);

		const event = makeSubEvent(
			{ id: sub.id },
			{ member: makeSubmitter(project.id, other.id) },
			{ encryptedPayload: 'p', encryptedKeyProject: 'k', encryptedKeyUser: 'u' }
		);
		await expect(migrateSubmission(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 400 when required fields are missing', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, member.id);

		const event = makeSubEvent(
			{ id: sub.id },
			{ member: makeSubmitter(project.id, member.id) },
			{ encryptedPayload: 'p' } // missing encryptedKeyProject and encryptedKeyUser
		);
		await expect(migrateSubmission(event)).rejects.toMatchObject({ status: 400 });
	});

	it('promotes a v1 submission to schemaVersion=2 and clears plaintext columns', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, member.id);

		const event = makeSubEvent(
			{ id: sub.id },
			{ member: makeSubmitter(project.id, member.id) },
			{
				encryptedPayload: 'new-encrypted-payload',
				encryptedKeyProject: 'new-key-project',
				encryptedKeyUser: 'new-key-user'
			}
		);
		const res = await migrateSubmission(event);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		// Verify DB state
		const updated = await testDb.db.submission.findUnique({ where: { id: sub.id } });
		expect(updated!.schemaVersion).toBe(2);
		expect(updated!.encryptedPayload).toBe('new-encrypted-payload');
		expect(updated!.encryptedKeyProject).toBe('new-key-project');
		expect(updated!.encryptedKeyUser).toBe('new-key-user');
		expect(updated!.type).toBeNull();
		expect(updated!.archiveCandidateUrl).toBeNull();
		expect(updated!.archiveUrl).toBeNull();
	});

	it('is idempotent: calling again on a v2 submission returns ok:true without error', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, member.id);

		const body = {
			encryptedPayload: 'migrated-payload',
			encryptedKeyProject: 'migrated-key-project',
			encryptedKeyUser: 'migrated-key-user'
		};

		// First call promotes to v2
		await migrateSubmission(makeSubEvent({ id: sub.id }, { member: makeSubmitter(project.id, member.id) }, body));

		// Second call is a no-op and still returns ok
		const res = await migrateSubmission(makeSubEvent({ id: sub.id }, { member: makeSubmitter(project.id, member.id) }, body));
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);

		// DB unchanged after second call
		const updated = await testDb.db.submission.findUnique({ where: { id: sub.id } });
		expect(updated!.schemaVersion).toBe(2);
		expect(updated!.encryptedPayload).toBe('migrated-payload');
	});

	it('MODERATOR can migrate any submission in their project', async () => {
		const project = await seedProject(testDb.db);
		const submitter = await seedMember(testDb.db, project.id, 'SUBMITTER');
		const moderator = await seedMember(testDb.db, project.id, 'MODERATOR');
		const sub = await seedV1Submission(testDb.db, project.id, submitter.id);

		const event = makeSubEvent(
			{ id: sub.id },
			{ member: makeModerator(project.id, moderator.id) },
			{ encryptedPayload: 'mod-payload', encryptedKeyProject: 'mk', encryptedKeyUser: 'mu' }
		);
		const res = await migrateSubmission(event);
		expect(res.status).toBe(200);
	});
});

// ── file migrate tests ────────────────────────────────────────────────────────

describe('PATCH /api/submissions/[id]/files/[fileId]/migrate', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
		_db = testDb.db;
	});

	afterEach(() => { testDb.cleanup(); });

	it('returns 401 when unauthenticated', async () => {
		const event = makeFileEvent({ id: 'sub', fileId: 'file' }, { member: undefined }, {});
		await expect(migrateFile(event)).rejects.toMatchObject({ status: 401 });
	});

	it('returns 404 when file does not exist', async () => {
		const project = await seedProject(testDb.db);
		const event = makeFileEvent(
			{ id: 'sub', fileId: 'nonexistent' },
			{ member: makeModerator(project.id) },
			{ encryptedMeta: 'meta' }
		);
		await expect(migrateFile(event)).rejects.toMatchObject({ status: 404 });
	});

	it('returns 403 when file belongs to a different project', async () => {
		const proj1 = await seedProject(testDb.db);
		const proj2 = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, proj1.id);
		const sub = await seedV1Submission(testDb.db, proj1.id, member.id);
		const file = await seedV1File(testDb.db, sub.id);

		const event = makeFileEvent(
			{ id: sub.id, fileId: file.id },
			{ member: makeModerator(proj2.id) },
			{ encryptedMeta: 'meta' }
		);
		await expect(migrateFile(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 403 when a SUBMITTER tries to migrate another member\'s file', async () => {
		const project = await seedProject(testDb.db);
		const owner = await seedMember(testDb.db, project.id);
		const other = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, owner.id);
		const file = await seedV1File(testDb.db, sub.id);

		const event = makeFileEvent(
			{ id: sub.id, fileId: file.id },
			{ member: makeSubmitter(project.id, other.id) },
			{ encryptedMeta: 'meta' }
		);
		await expect(migrateFile(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 400 when encryptedMeta is missing', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, member.id);
		const file = await seedV1File(testDb.db, sub.id);

		const event = makeFileEvent(
			{ id: sub.id, fileId: file.id },
			{ member: makeSubmitter(project.id, member.id) },
			{} // missing encryptedMeta
		);
		await expect(migrateFile(event)).rejects.toMatchObject({ status: 400 });
	});

	it('promotes a v1 file to schemaVersion=2 and clears mimeType', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, member.id);
		const file = await seedV1File(testDb.db, sub.id);

		const event = makeFileEvent(
			{ id: sub.id, fileId: file.id },
			{ member: makeSubmitter(project.id, member.id) },
			{ encryptedMeta: 'encrypted-mime-type-ciphertext' }
		);
		const res = await migrateFile(event);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);

		// Verify DB state
		const updated = await testDb.db.submissionFile.findUnique({ where: { id: file.id } });
		expect(updated!.schemaVersion).toBe(2);
		expect(updated!.encryptedMeta).toBe('encrypted-mime-type-ciphertext');
		expect(updated!.mimeType).toBeNull();
	});

	it('is idempotent: calling again on a v2 file returns ok:true without error', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const sub = await seedV1Submission(testDb.db, project.id, member.id);
		const file = await seedV1File(testDb.db, sub.id);

		const body = { encryptedMeta: 'encrypted-meta' };

		// First call promotes to v2
		await migrateFile(makeFileEvent({ id: sub.id, fileId: file.id }, { member: makeSubmitter(project.id, member.id) }, body));

		// Second call returns ok without error
		const res = await migrateFile(makeFileEvent({ id: sub.id, fileId: file.id }, { member: makeSubmitter(project.id, member.id) }, body));
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
	});
});
