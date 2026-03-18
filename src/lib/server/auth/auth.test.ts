import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { issueChallenge, verifyChallenge, AuthError, CHALLENGE_TTL_MS } from './index';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';
import {
	generateUserKeyBundle,
	exportPublicKeyJwk,
	jwkToString,
	type UserKeyBundle
} from '$lib/crypto/keys';
import { sign } from '$lib/crypto/signing';

// ── helpers ──────────────────────────────────────────────────────────────────

async function seedUser(db: TestDb['db'], bundle?: UserKeyBundle) {
	const keys = bundle ?? (await generateUserKeyBundle());
	const signingPublicKey = jwkToString(await exportPublicKeyJwk(keys.signing.publicKey));
	const encryptionPublicKey = jwkToString(await exportPublicKeyJwk(keys.encryption.publicKey));
	const user = await db.user.create({
		data: { signingPublicKey, encryptionPublicKey, encryptedName: 'enc-name', encryptedContact: 'enc-contact' }
	});
	return { user, keys };
}

async function buildValidBody(nonce: string, keys: UserKeyBundle, signingPublicKey: string) {
	const signature = await sign(keys.signing.privateKey, new TextEncoder().encode(nonce));
	return { signingPublicKey, nonce, signature };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('auth service', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
	});

	afterEach(() => {
		testDb.cleanup();
	});

	// ── issueChallenge ──────────────────────────────────────────────────────

	describe('issueChallenge', () => {
		it('returns a non-empty nonce string', async () => {
			const { db } = testDb;
			const nonce = await issueChallenge(db);
			expect(typeof nonce).toBe('string');
			expect(nonce.length).toBeGreaterThan(0);
		});

		it('stores the challenge in the database', async () => {
			const { db } = testDb;
			const nonce = await issueChallenge(db);
			const stored = await db.challenge.findUnique({ where: { nonce } });
			expect(stored).not.toBeNull();
			expect(stored!.expiresAt.getTime()).toBeGreaterThan(Date.now());
		});

		it('stores challenge with expiry ~5 minutes in the future', async () => {
			const { db } = testDb;
			const before = Date.now();
			const nonce = await issueChallenge(db);
			const stored = await db.challenge.findUnique({ where: { nonce } });
			const expiresMs = stored!.expiresAt.getTime();
			expect(expiresMs).toBeGreaterThanOrEqual(before + CHALLENGE_TTL_MS - 1000);
			expect(expiresMs).toBeLessThanOrEqual(before + CHALLENGE_TTL_MS + 1000);
		});

		it('each call produces a unique nonce', async () => {
			const { db } = testDb;
			const n1 = await issueChallenge(db);
			const n2 = await issueChallenge(db);
			expect(n1).not.toBe(n2);
		});
	});

	// ── verifyChallenge — happy path ────────────────────────────────────────

	describe('verifyChallenge — happy path', () => {
		it('returns userId and token for a valid signed challenge', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const nonce = await issueChallenge(db);
			const body = await buildValidBody(nonce, keys, user.signingPublicKey);

			const result = await verifyChallenge(body, db);

			expect(result.userId).toBe(user.id);
			expect(typeof result.token).toBe('string');
			expect(result.token.length).toBeGreaterThan(0);
		});

		it('creates a session record in the database', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const nonce = await issueChallenge(db);
			const body = await buildValidBody(nonce, keys, user.signingPublicKey);

			const { token } = await verifyChallenge(body, db);
			const session = await db.session.findUnique({ where: { token } });

			expect(session).not.toBeNull();
			expect(session!.userId).toBe(user.id);
		});

		it('consumes the nonce so it cannot be reused', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const nonce = await issueChallenge(db);
			const body = await buildValidBody(nonce, keys, user.signingPublicKey);

			await verifyChallenge(body, db);

			// Nonce should be gone from DB
			const stored = await db.challenge.findUnique({ where: { nonce } });
			expect(stored).toBeNull();
		});
	});

	// ── verifyChallenge — non-happy path ────────────────────────────────────

	describe('verifyChallenge — non-happy path', () => {
		it('throws 400 for a non-object body', async () => {
			const { db } = testDb;
			await expect(verifyChallenge('not an object', db)).rejects.toMatchObject({
				statusCode: 400
			});
		});

		it('throws 400 for a null body', async () => {
			const { db } = testDb;
			await expect(verifyChallenge(null, db)).rejects.toMatchObject({ statusCode: 400 });
		});

		it('throws 400 when required fields are missing', async () => {
			const { db } = testDb;
			await expect(verifyChallenge({ signingPublicKey: 'pk' }, db)).rejects.toMatchObject({
				statusCode: 400
			});
		});

		it('throws 400 when fields have wrong types', async () => {
			const { db } = testDb;
			await expect(
				verifyChallenge({ signingPublicKey: 1, nonce: 'n', signature: 's' }, db)
			).rejects.toMatchObject({ statusCode: 400 });
		});

		it('throws 401 for an unknown nonce', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const fakeNonce = 'no-such-nonce-was-ever-issued';
			const signature = await sign(keys.signing.privateKey, new TextEncoder().encode(fakeNonce));

			await expect(
				verifyChallenge({ signingPublicKey: user.signingPublicKey, nonce: fakeNonce, signature }, db)
			).rejects.toMatchObject({ statusCode: 401 });
		});

		it('throws 401 for a replay (nonce used twice)', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const nonce = await issueChallenge(db);
			const body = await buildValidBody(nonce, keys, user.signingPublicKey);

			await verifyChallenge(body, db); // first use succeeds

			// Second use must be rejected
			await expect(verifyChallenge(body, db)).rejects.toMatchObject({ statusCode: 401 });
		});

		it('throws 401 for an expired nonce', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);

			// Insert an already-expired challenge directly
			const nonce = 'expired-nonce-xyz';
			await db.challenge.create({
				data: { nonce, expiresAt: new Date(Date.now() - 1000) }
			});
			const signature = await sign(keys.signing.privateKey, new TextEncoder().encode(nonce));

			await expect(
				verifyChallenge({ signingPublicKey: user.signingPublicKey, nonce, signature }, db)
			).rejects.toMatchObject({ statusCode: 401 });

			// Expired challenge should be consumed/deleted
			const stored = await db.challenge.findUnique({ where: { nonce } });
			expect(stored).toBeNull();
		});

		it('throws 401 for an unknown signing key', async () => {
			const { db } = testDb;
			const keys = await generateUserKeyBundle();
			const unknownKey = jwkToString(await exportPublicKeyJwk(keys.signing.publicKey));
			const nonce = await issueChallenge(db);
			const signature = await sign(keys.signing.privateKey, new TextEncoder().encode(nonce));

			await expect(
				verifyChallenge({ signingPublicKey: unknownKey, nonce, signature }, db)
			).rejects.toMatchObject({ statusCode: 401 });
		});

		it('throws 401 for an invalid (wrong-key) signature', async () => {
			const { db } = testDb;
			const { user } = await seedUser(db);
			const otherKeys = await generateUserKeyBundle(); // different keypair
			const nonce = await issueChallenge(db);
			// Sign with the wrong private key
			const signature = await sign(otherKeys.signing.privateKey, new TextEncoder().encode(nonce));

			await expect(
				verifyChallenge({ signingPublicKey: user.signingPublicKey, nonce, signature }, db)
			).rejects.toMatchObject({ statusCode: 401 });
		});

		it('throws 401 for a tampered signature', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const nonce = await issueChallenge(db);
			const sig = await sign(keys.signing.privateKey, new TextEncoder().encode(nonce));
			const tampered = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');

			await expect(
				verifyChallenge({ signingPublicKey: user.signingPublicKey, nonce, signature: tampered }, db)
			).rejects.toMatchObject({ statusCode: 401 });
		});

		it('throws 401 for a signature over different data (wrong message)', async () => {
			const { db } = testDb;
			const { user, keys } = await seedUser(db);
			const nonce = await issueChallenge(db);
			// Sign a different message
			const signature = await sign(keys.signing.privateKey, new TextEncoder().encode('not the nonce'));

			await expect(
				verifyChallenge({ signingPublicKey: user.signingPublicKey, nonce, signature }, db)
			).rejects.toMatchObject({ statusCode: 401 });
		});

		it('thrown errors are AuthError instances', async () => {
			const { db } = testDb;
			await expect(verifyChallenge(null, db)).rejects.toBeInstanceOf(AuthError);
		});
	});
});
