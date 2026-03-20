import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSession, validateSession, deleteSession } from './index';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';

// Helper: create a project + member in the test DB
async function seedMember(db: TestDb['db'], signingPublicKey = 'spk-test') {
	const project = await db.project.create({ data: { name: 'Test Project' } });
	return db.member.create({
		data: {
			projectId: project.id,
			signingPublicKey,
			encryptionPublicKey: `epk-${signingPublicKey}`,
			encryptedName: 'enc-name',
			encryptedContact: 'enc-contact',
			role: 'SUBMITTER'
		}
	});
}

describe('session management', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
	});

	afterEach(() => {
		testDb.cleanup();
	});

	// ── Happy path ─────────────────────────────────────────────────────────────

	it('createSession returns a non-empty token string', async () => {
		const { db } = testDb;
		const member = await seedMember(db);

		const token = await createSession(member.id, db);

		expect(typeof token).toBe('string');
		expect(token.length).toBeGreaterThan(0);
	});

	it('createSession stores the session in the database', async () => {
		const { db } = testDb;
		const member = await seedMember(db);

		const token = await createSession(member.id, db);
		const session = await db.session.findUnique({ where: { token } });

		expect(session).not.toBeNull();
		expect(session!.memberId).toBe(member.id);
		expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it('validateSession returns the member for a valid token', async () => {
		const { db } = testDb;
		const member = await seedMember(db);
		const token = await createSession(member.id, db);

		const result = await validateSession(token, db);

		expect(result).not.toBeNull();
		expect(result!.id).toBe(member.id);
		expect(result!.signingPublicKey).toBe('spk-test');
	});

	it('each createSession call produces a unique token', async () => {
		const { db } = testDb;
		const member = await seedMember(db);

		const t1 = await createSession(member.id, db);
		const t2 = await createSession(member.id, db);

		expect(t1).not.toBe(t2);
	});

	// ── Non-happy path ─────────────────────────────────────────────────────────

	it('validateSession returns null for undefined token', async () => {
		const { db } = testDb;

		const result = await validateSession(undefined, db);

		expect(result).toBeNull();
	});

	it('validateSession returns null for an unknown token', async () => {
		const { db } = testDb;

		const result = await validateSession('this-token-does-not-exist', db);

		expect(result).toBeNull();
	});

	it('validateSession returns null for a tampered token', async () => {
		const { db } = testDb;
		const member = await seedMember(db);
		const token = await createSession(member.id, db);

		const result = await validateSession(token + 'tampered', db);

		expect(result).toBeNull();
	});

	it('validateSession returns null and removes an expired session', async () => {
		const { db } = testDb;
		const member = await seedMember(db);

		// Insert an already-expired session directly
		const token = 'expired-token-abc';
		await db.session.create({
			data: {
				memberId: member.id,
				token,
				expiresAt: new Date(Date.now() - 1000) // 1 second in the past
			}
		});

		const result = await validateSession(token, db);
		expect(result).toBeNull();

		// Expired session should have been lazily deleted
		const session = await db.session.findUnique({ where: { token } });
		expect(session).toBeNull();
	});

	it('validateSession returns null after deleteSession', async () => {
		const { db } = testDb;
		const member = await seedMember(db);
		const token = await createSession(member.id, db);

		await deleteSession(token, db);
		const result = await validateSession(token, db);

		expect(result).toBeNull();
	});

	it('deleteSession is a no-op for an unknown token', async () => {
		const { db } = testDb;

		// Should not throw
		await expect(deleteSession('no-such-token', db)).resolves.toBeUndefined();
	});

	it('validateSession returns null when the associated member has been deleted', async () => {
		const { db } = testDb;
		const member = await seedMember(db, 'spk-to-delete');
		const token = await createSession(member.id, db);

		// Cascade delete removes the session along with the member
		await db.member.delete({ where: { id: member.id } });

		const result = await validateSession(token, db);
		expect(result).toBeNull();
	});
});
