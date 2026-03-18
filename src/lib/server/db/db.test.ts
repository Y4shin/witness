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

	it('creates a user', async () => {
		const { db } = testDb;
		const user = await db.user.create({
			data: {
				publicKey: 'pk-abc123',
				encryptedName: 'enc-name',
				encryptedContact: 'enc-contact'
			}
		});

		expect(user.id).toBeTruthy();
		expect(user.publicKey).toBe('pk-abc123');
	});

	it('enforces unique publicKey on user', async () => {
		const { db } = testDb;
		await db.user.create({
			data: { publicKey: 'same-key', encryptedName: 'a', encryptedContact: 'b' }
		});

		await expect(
			db.user.create({
				data: { publicKey: 'same-key', encryptedName: 'c', encryptedContact: 'd' }
			})
		).rejects.toThrow();
	});

	it('cascades deletion from project to memberships', async () => {
		const { db } = testDb;
		const project = await db.project.create({ data: { name: 'Cascade Project' } });
		const user = await db.user.create({
			data: { publicKey: 'pk-cascade', encryptedName: 'n', encryptedContact: 'c' }
		});
		await db.membership.create({
			data: { userId: user.id, projectId: project.id, role: 'SUBMITTER' }
		});

		await db.project.delete({ where: { id: project.id } });

		const memberships = await db.membership.findMany({ where: { userId: user.id } });
		expect(memberships).toHaveLength(0);
	});

	it('rejects a membership referencing a non-existent user', async () => {
		const { db } = testDb;
		const project = await db.project.create({ data: { name: 'FK Project' } });

		await expect(
			db.membership.create({
				data: { userId: 'does-not-exist', projectId: project.id, role: 'SUBMITTER' }
			})
		).rejects.toThrow();
	});
});
