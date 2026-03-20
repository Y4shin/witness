import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMember, MemberCreationError } from './index';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';
import { generateUserKeyBundle, exportPublicKeyJwk, jwkToString } from '$lib/crypto/keys';

async function makeKeyStrings() {
	const bundle = await generateUserKeyBundle();
	return {
		signingPublicKey: jwkToString(await exportPublicKeyJwk(bundle.signing.publicKey)),
		encryptionPublicKey: jwkToString(await exportPublicKeyJwk(bundle.encryption.publicKey))
	};
}

describe('createMember', () => {
	let testDb: TestDb;
	let projectId: string;

	beforeEach(async () => {
		testDb = await createTestDb();
		const project = await testDb.db.project.create({ data: { name: 'Test Project' } });
		projectId = project.id;
	});

	afterEach(() => {
		testDb.cleanup();
	});

	// ── happy path ──────────────────────────────────────────────────────────

	it('creates a member and returns it', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();

		const member = await createMember(
			{ projectId, signingPublicKey, encryptionPublicKey, encryptedName: 'enc-name', encryptedContact: 'enc-contact', role: 'SUBMITTER' },
			db
		);

		expect(member.id).toBeTruthy();
		expect(member.signingPublicKey).toBe(signingPublicKey);
		expect(member.encryptionPublicKey).toBe(encryptionPublicKey);
		expect(member.projectId).toBe(projectId);
		expect(member.role).toBe('SUBMITTER');
	});

	it('persists the member to the database', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();

		const member = await createMember(
			{ projectId, signingPublicKey, encryptionPublicKey, encryptedName: 'n', encryptedContact: 'c', role: 'MODERATOR' },
			db
		);

		const found = await db.member.findUnique({ where: { id: member.id } });
		expect(found).not.toBeNull();
		expect(found!.signingPublicKey).toBe(signingPublicKey);
	});

	// ── non-happy path ──────────────────────────────────────────────────────

	it('throws 400 when signingPublicKey is missing', async () => {
		const { db } = testDb;
		await expect(
			createMember({ projectId, signingPublicKey: '', encryptionPublicKey: 'k', encryptedName: 'n', encryptedContact: 'c', role: 'SUBMITTER' }, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 when encryptionPublicKey is missing', async () => {
		const { db } = testDb;
		await expect(
			createMember({ projectId, signingPublicKey: 'k', encryptionPublicKey: '', encryptedName: 'n', encryptedContact: 'c', role: 'SUBMITTER' }, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 for an invalid signingPublicKey (not valid JWK)', async () => {
		const { db } = testDb;
		const { encryptionPublicKey } = await makeKeyStrings();
		await expect(
			createMember({
				projectId,
				signingPublicKey: '{"kty":"not-valid"}',
				encryptionPublicKey,
				encryptedName: 'n',
				encryptedContact: 'c',
				role: 'SUBMITTER'
			}, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 400 for an invalid encryptionPublicKey (not valid JWK)', async () => {
		const { db } = testDb;
		const { signingPublicKey } = await makeKeyStrings();
		await expect(
			createMember({
				projectId,
				signingPublicKey,
				encryptionPublicKey: 'not json at all',
				encryptedName: 'n',
				encryptedContact: 'c',
				role: 'SUBMITTER'
			}, db)
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('throws 409 when the same signingPublicKey is registered twice', async () => {
		const { db } = testDb;
		const { signingPublicKey, encryptionPublicKey } = await makeKeyStrings();
		const { encryptionPublicKey: epk2 } = await makeKeyStrings();

		await createMember({ projectId, signingPublicKey, encryptionPublicKey, encryptedName: 'n', encryptedContact: 'c', role: 'SUBMITTER' }, db);

		await expect(
			createMember({ projectId, signingPublicKey, encryptionPublicKey: epk2, encryptedName: 'n2', encryptedContact: 'c2', role: 'SUBMITTER' }, db)
		).rejects.toMatchObject({ statusCode: 409 });
	});

	it('thrown errors are MemberCreationError instances', async () => {
		const { db } = testDb;
		await expect(
			createMember({ projectId, signingPublicKey: '', encryptionPublicKey: '', encryptedName: '', encryptedContact: '', role: 'SUBMITTER' }, db)
		).rejects.toBeInstanceOf(MemberCreationError);
	});
});
