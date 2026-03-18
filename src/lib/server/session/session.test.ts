import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSession, validateSession, deleteSession } from './index';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';

// Helper: create a user in the test DB
async function seedUser(db: TestDb['db'], publicKey = 'pk-test') {
	return db.user.create({
		data: { publicKey, encryptedName: 'enc-name', encryptedContact: 'enc-contact' }
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
		const user = await seedUser(db);

		const token = await createSession(user.id, db);

		expect(typeof token).toBe('string');
		expect(token.length).toBeGreaterThan(0);
	});

	it('createSession stores the session in the database', async () => {
		const { db } = testDb;
		const user = await seedUser(db);

		const token = await createSession(user.id, db);
		const session = await db.session.findUnique({ where: { token } });

		expect(session).not.toBeNull();
		expect(session!.userId).toBe(user.id);
		expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it('validateSession returns the user for a valid token', async () => {
		const { db } = testDb;
		const user = await seedUser(db);
		const token = await createSession(user.id, db);

		const result = await validateSession(token, db);

		expect(result).not.toBeNull();
		expect(result!.id).toBe(user.id);
		expect(result!.publicKey).toBe('pk-test');
	});

	it('each createSession call produces a unique token', async () => {
		const { db } = testDb;
		const user = await seedUser(db);

		const t1 = await createSession(user.id, db);
		const t2 = await createSession(user.id, db);

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
		const user = await seedUser(db);
		const token = await createSession(user.id, db);

		const result = await validateSession(token + 'tampered', db);

		expect(result).toBeNull();
	});

	it('validateSession returns null and removes an expired session', async () => {
		const { db } = testDb;
		const user = await seedUser(db);

		// Insert an already-expired session directly
		const token = 'expired-token-abc';
		await db.session.create({
			data: {
				userId: user.id,
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
		const user = await seedUser(db);
		const token = await createSession(user.id, db);

		await deleteSession(token, db);
		const result = await validateSession(token, db);

		expect(result).toBeNull();
	});

	it('deleteSession is a no-op for an unknown token', async () => {
		const { db } = testDb;

		// Should not throw
		await expect(deleteSession('no-such-token', db)).resolves.toBeUndefined();
	});

	it('validateSession returns null when the associated user has been deleted', async () => {
		const { db } = testDb;
		const user = await seedUser(db, 'pk-to-delete');
		const token = await createSession(user.id, db);

		// Cascade delete removes the session along with the user
		await db.user.delete({ where: { id: user.id } });

		const result = await validateSession(token, db);
		expect(result).toBeNull();
	});
});
