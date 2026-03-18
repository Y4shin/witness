import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createUser, UserCreationError } from './index';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';
import { generateUserKeyBundle, exportPublicKeyJwk, jwkToString } from '$lib/crypto/keys';

async function makeKeyStrings() {
	const bundle = await generateUserKeyBundle();
	return {
		signingPublicKey: jwkToString(await exportPublicKeyJwk(bundle.signing.publicKey)),
		encryptionPublicKey: jwkToString(await exportPublicKeyJwk(bundle.encryption.publicKey))
	};
}

describe('createUser', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
	});

	afterEach(() => {
		testDb.cleanup();
	});

	// ── happy path ──────────────────────────────────────────────────────────

	it('creates a user and returns it', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();

		const user = await createUser(
			{ signingPublicKey, encryptionPublicKey, encryptedName: 'enc-name', encryptedContact: 'enc-contact' },
			db
		);

		expect(user.id).toBeTruthy();
		expect(user.signingPublicKey).toBe(signingPublicKey);
		expect(user.encryptionPublicKey).toBe(encryptionPublicKey);
	});

	it('persists the user to the database', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();

		const user = await createUser(
			{ signingPublicKey, encryptionPublicKey, encryptedName: 'n', encryptedContact: 'c' },
			db
		);

		const found = await db.user.findUnique({ where: { id: user.id } });
		expect(found).not.toBeNull();
		expect(found!.signingPublicKey).toBe(signingPublicKey);
	});

	// ── non-happy path ──────────────────────────────────────────────────────

	it('throws 400 when signingPublicKey is missing', async () => {
		const { db } = testDb;
		await expect(
			createUser({ signingPublicKey: '', encryptionPublicKey: 'k', encryptedName: 'n', encryptedContact: 'c' }, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 when encryptionPublicKey is missing', async () => {
		const { db } = testDb;
		await expect(
			createUser({ signingPublicKey: 'k', encryptionPublicKey: '', encryptedName: 'n', encryptedContact: 'c' }, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 when encryptedName is missing', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();
		await expect(
			createUser({ signingPublicKey, encryptionPublicKey, encryptedName: '', encryptedContact: 'c' }, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 when encryptedContact is missing', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();
		await expect(
			createUser({ signingPublicKey, encryptionPublicKey, encryptedName: 'n', encryptedContact: '' }, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 for an invalid signingPublicKey (not valid JWK)', async () => {
		const { db } = testDb;
		const { encryptionPublicKey } = await makeKeyStrings();
		await expect(
			createUser({
				signingPublicKey: '{"kty":"not-valid"}',
				encryptionPublicKey,
				encryptedName: 'n',
				encryptedContact: 'c'
			}, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 for an invalid encryptionPublicKey (not valid JWK)', async () => {
		const { db } = testDb;
		const { signingPublicKey } = await makeKeyStrings();
		await expect(
			createUser({
				signingPublicKey,
				encryptionPublicKey: 'not json at all',
				encryptedName: 'n',
				encryptedContact: 'c'
			}, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 409 when the same signingPublicKey is registered twice', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();
		const { encryptionPublicKey: epk2 } = await makeKeyStrings();

		await createUser({ signingPublicKey, encryptionPublicKey, encryptedName: 'n', encryptedContact: 'c' }, db);

		await expect(
			createUser({ signingPublicKey, encryptionPublicKey: epk2, encryptedName: 'n2', encryptedContact: 'c2' }, db)
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it('thrown errors are UserCreationError instances', async () => {
		const { db } = testDb;
		await expect(
			createUser({ signingPublicKey: '', encryptionPublicKey: '', encryptedName: '', encryptedContact: '' }, db)
		).rejects.toBeInstanceOf(UserCreationError);
	});
});
