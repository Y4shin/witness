/**
 * Integration tests for GET /api/submissions/[id]/files
 *
 * Covers:
 *  - 401 when unauthenticated
 *  - 404 when submission does not exist
 *  - 403 when submission belongs to a different project
 *  - 403 when a SUBMITTER requests another member's submission
 *  - 200 for MODERATORs — correct records in createdAt order; encryptedKey is project key
 *  - 200 for SUBMITTERs accessing their own submission — encryptedKey is user key
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';
import type { PrismaClient } from '$lib/server/prisma/client';

// ── db injection via module mock ────────────────────────────────────────────
// vi.mock is hoisted above imports; the getter is evaluated lazily at call
// time, so it returns whichever testDb we set in beforeEach.
let _db: PrismaClient;
vi.mock('$lib/server/db', () => ({ get db() { return _db; } }));

// Import AFTER mock is declared so the handler picks up the mock
const { GET } = await import('./+server');

// ── helpers ─────────────────────────────────────────────────────────────────

function makeModerator(projectId: string, memberId = 'mod-1') {
	return { id: memberId, projectId, role: 'MODERATOR' as const };
}

function makeSubmitter(projectId: string, memberId = 'sub-1') {
	return { id: memberId, projectId, role: 'SUBMITTER' as const };
}

/** Minimal RequestEvent mock — only fields used by the handler. */
function makeEvent(params: Record<string, string>, locals: { member?: unknown }) {
	return { params, locals } as Parameters<typeof GET>[0];
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

async function seedFile(
	db: PrismaClient,
	submissionId: string,
	overrides: { fieldName?: string; mimeType?: string; encryptedKey?: string; encryptedKeyUser?: string } = {}
) {
	return db.submissionFile.create({
		data: {
			submissionId,
			fieldName: overrides.fieldName ?? 'evidence',
			mimeType: overrides.mimeType ?? 'image/jpeg',
			storagePath: '/tmp/fake.enc',
			encryptedKey: overrides.encryptedKey ?? '{"key":"value"}',
			encryptedKeyUser: overrides.encryptedKeyUser ?? '{"user":"key"}',
			sizeBytes: 1024
		}
	});
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('GET /api/submissions/[id]/files', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
		_db = testDb.db;
	});

	afterEach(() => {
		testDb.cleanup();
	});

	it('returns 401 when unauthenticated', async () => {
		const event = makeEvent({ id: 'any' }, { member: undefined });
		await expect(GET(event)).rejects.toMatchObject({ status: 401 });
	});

	it('returns 403 when a SUBMITTER requests another member\'s submission', async () => {
		const project = await seedProject(testDb.db);
		const owner = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, owner.id);

		// Different submitter trying to access owner's submission
		const other = await seedMember(testDb.db, project.id);
		const event = makeEvent(
			{ id: submission.id },
			{ member: makeSubmitter(project.id, other.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 404 when submission does not exist', async () => {
		const project = await seedProject(testDb.db);
		const event = makeEvent(
			{ id: 'nonexistent-id' },
			{ member: makeModerator(project.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 404 });
	});

	it('returns 403 when submission belongs to a different project', async () => {
		const project1 = await seedProject(testDb.db);
		const project2 = await seedProject(testDb.db);

		const member1 = await seedMember(testDb.db, project1.id);
		const submission = await seedSubmission(testDb.db, project1.id, member1.id);

		// Moderator is from project2, but submission is in project1
		const event = makeEvent(
			{ id: submission.id },
			{ member: makeModerator(project2.id) }
		);
		await expect(GET(event)).rejects.toMatchObject({ status: 403 });
	});

	it('returns 200 with an empty files array when submission has no files', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);

		const event = makeEvent(
			{ id: submission.id },
			{ member: makeModerator(project.id) }
		);
		const res = await GET(event);
		expect(res.status).toBe(200);

		const body = await res.json() as { files: unknown[] };
		expect(body.files).toEqual([]);
	});

	it('returns file records with the correct shape', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);
		await seedFile(testDb.db, submission.id, {
			fieldName: 'screenshot',
			mimeType: 'image/png',
			encryptedKey: '{"k":"test-key"}'
		});

		const event = makeEvent(
			{ id: submission.id },
			{ member: makeModerator(project.id) }
		);
		const res = await GET(event);
		expect(res.status).toBe(200);

		const body = await res.json() as { files: Array<Record<string, unknown>> };
		expect(body.files).toHaveLength(1);
		const file = body.files[0];
		expect(file.id).toBeTruthy();
		expect(file.fieldName).toBe('screenshot');
		expect(file.mimeType).toBe('image/png');
		expect(file.sizeBytes).toBe(1024);
		expect(file.createdAt).toBeTruthy();
		expect(file.encryptedKey).toBe('{"k":"test-key"}');
	});

	it('does NOT include storagePath or encryptedKeyUser in the response', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);
		await seedFile(testDb.db, submission.id);

		const event = makeEvent(
			{ id: submission.id },
			{ member: makeModerator(project.id) }
		);
		const res = await GET(event);
		const body = await res.json() as { files: Array<Record<string, unknown>> };
		const file = body.files[0];
		expect(file).not.toHaveProperty('storagePath');
		expect(file).not.toHaveProperty('encryptedKeyUser');
	});

	it('returns 200 for a SUBMITTER accessing their own submission', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);
		await seedFile(testDb.db, submission.id);

		const event = makeEvent(
			{ id: submission.id },
			{ member: makeSubmitter(project.id, member.id) }
		);
		const res = await GET(event);
		expect(res.status).toBe(200);

		const body = await res.json() as { files: Array<Record<string, unknown>> };
		expect(body.files).toHaveLength(1);
	});

	it('returns encryptedKeyUser (not encryptedKey) for SUBMITTERs', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);
		await seedFile(testDb.db, submission.id, {
			encryptedKey: '{"project":"key"}',
			encryptedKeyUser: '{"user":"key"}'
		});

		const submitterEvent = makeEvent(
			{ id: submission.id },
			{ member: makeSubmitter(project.id, member.id) }
		);
		const submitterRes = await GET(submitterEvent);
		const submitterBody = await submitterRes.json() as { files: Array<Record<string, unknown>> };
		expect(submitterBody.files[0].encryptedKey).toBe('{"user":"key"}');

		// Re-create a fresh instance so the GET import isn't re-used with stale results
		const modEvent = makeEvent(
			{ id: submission.id },
			{ member: makeModerator(project.id) }
		);
		const modRes = await GET(modEvent);
		const modBody = await modRes.json() as { files: Array<Record<string, unknown>> };
		expect(modBody.files[0].encryptedKey).toBe('{"project":"key"}');
	});

	it('returns multiple files ordered by createdAt ascending', async () => {
		const project = await seedProject(testDb.db);
		const member = await seedMember(testDb.db, project.id);
		const submission = await seedSubmission(testDb.db, project.id, member.id);

		// Seed three files — DB will assign createdAt in insertion order
		const f1 = await seedFile(testDb.db, submission.id, { fieldName: 'first' });
		const f2 = await seedFile(testDb.db, submission.id, { fieldName: 'second' });
		const f3 = await seedFile(testDb.db, submission.id, { fieldName: 'third' });

		const event = makeEvent(
			{ id: submission.id },
			{ member: makeModerator(project.id) }
		);
		const res = await GET(event);
		const body = await res.json() as { files: Array<{ id: string; fieldName: string }> };

		expect(body.files).toHaveLength(3);
		// Should come back in insertion (createdAt asc) order
		expect(body.files.map((f) => f.id)).toEqual([f1.id, f2.id, f3.id]);
	});
});
