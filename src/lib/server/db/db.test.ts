import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './test-utils';

describe('database', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
	});

	afterEach(() => {
		testDb.cleanup();
	});

	it('connects and creates a project', async () => {
		const { db } = testDb;
		const project = await db.project.create({
			data: { name: 'Test Project' }
		});

		expect(project.id).toBeTruthy();
		expect(project.name).toBe('Test Project');
		expect(project.publicKey).toBeNull();
		expect(project.createdAt).toBeInstanceOf(Date);
	});

	it('reads back a created project', async () => {
		const { db } = testDb;
		const created = await db.project.create({ data: { name: 'Readable' } });
		const found = await db.project.findUniqueOrThrow({ where: { id: created.id } });

		expect(found.id).toBe(created.id);
		expect(found.name).toBe('Readable');
	});

	it('creates a member', async () => {
		const { db } = testDb;
		const project = await db.project.create({ data: { name: 'Member Project' } });
		const member = await db.member.create({
			data: {
				projectId: project.id,
				signingPublicKey: 'spk-abc123',
				encryptionPublicKey: 'epk-abc123',
				encryptedName: 'enc-name',
				encryptedContact: 'enc-contact',
				role: 'SUBMITTER'
			}
		});

		expect(member.id).toBeTruthy();
		expect(member.signingPublicKey).toBe('spk-abc123');
		expect(member.encryptionPublicKey).toBe('epk-abc123');
		expect(member.projectId).toBe(project.id);
	});

	it('enforces unique signingPublicKey on member', async () => {
		const { db } = testDb;
		const project = await db.project.create({ data: { name: 'Unique Key Project' } });
		await db.member.create({
			data: {
				projectId: project.id,
				signingPublicKey: 'same-spk',
				encryptionPublicKey: 'epk-1',
				encryptedName: 'a',
				encryptedContact: 'b',
				role: 'SUBMITTER'
			}
		});

		await expect(
			db.member.create({
				data: {
					projectId: project.id,
					signingPublicKey: 'same-spk',
					encryptionPublicKey: 'epk-2',
					encryptedName: 'c',
					encryptedContact: 'd',
					role: 'SUBMITTER'
				}
			})
		).rejects.toThrow();
	});

	it('cascades deletion from project to members', async () => {
		const { db } = testDb;
		const project = await db.project.create({ data: { name: 'Cascade Project' } });
		const member = await db.member.create({
			data: {
				projectId: project.id,
				signingPublicKey: 'spk-cascade',
				encryptionPublicKey: 'epk-cascade',
				encryptedName: 'n',
				encryptedContact: 'c',
				role: 'SUBMITTER'
			}
		});

		await db.project.delete({ where: { id: project.id } });

		const found = await db.member.findUnique({ where: { id: member.id } });
		expect(found).toBeNull();
	});

	it('rejects a member referencing a non-existent project', async () => {
		const { db } = testDb;

		await expect(
			db.member.create({
				data: {
					projectId: 'does-not-exist',
					signingPublicKey: 'spk-fk',
					encryptionPublicKey: 'epk-fk',
					encryptedName: 'n',
					encryptedContact: 'c',
					role: 'SUBMITTER'
				}
			})
		).rejects.toThrow();
	});
});
