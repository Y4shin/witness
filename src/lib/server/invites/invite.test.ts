import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getInviteInfo, claimInvite, createInvite } from './index';
import { createTestDb, type TestDb } from '$lib/server/db/test-utils';

// ── helpers ───────────────────────────────────────────────────────────────────

async function seedProject(db: TestDb['db'], name = 'Test Project') {
	return db.project.create({ data: { name } });
}

async function seedInvite(
	db: TestDb['db'],
	projectId: string,
	overrides: {
		maxUses?: number | null;
		usedCount?: number;
		expiresAt?: Date | null;
	} = {}
) {
	return db.inviteLink.create({
		data: {
			token: `token-${Math.random().toString(36).slice(2)}`,
			projectId,
			role: 'MODERATOR',
			maxUses: overrides.maxUses ?? null,
			usedCount: overrides.usedCount ?? 0,
			expiresAt: overrides.expiresAt ?? null
		}
	});
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('invite service', () => {
	let testDb: TestDb;

	beforeEach(async () => {
		testDb = await createTestDb();
	});

	afterEach(() => {
		testDb.cleanup();
	});

	// ── getInviteInfo — happy path ─────────────────────────────────────────

	describe('getInviteInfo — happy path', () => {
		it('returns project info and role for a valid token', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id);

			const info = await getInviteInfo(invite.token, testDb.db);

			expect(info.projectId).toBe(project.id);
			expect(info.projectName).toBe('Test Project');
			expect(info.role).toBe('MODERATOR');
		});

		it('does not increment used_count', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id);

			await getInviteInfo(invite.token, testDb.db);
			await getInviteInfo(invite.token, testDb.db);

			const updated = await testDb.db.inviteLink.findUnique({ where: { token: invite.token } });
			expect(updated!.usedCount).toBe(0);
		});
	});

	// ── getInviteInfo — non-happy path ────────────────────────────────────

	describe('getInviteInfo — non-happy path', () => {
		it('throws 404 for an unknown token', async () => {
			await expect(getInviteInfo('no-such-token', testDb.db)).rejects.toMatchObject({
				statusCode: 404
			});
		});

		it('throws 410 for an expired token', async () => {
			const project = await seedProject(testDb.db);
			const pastDate = new Date(Date.now() - 60_000);
			const invite = await seedInvite(testDb.db, project.id, { expiresAt: pastDate });

			await expect(getInviteInfo(invite.token, testDb.db)).rejects.toMatchObject({
				statusCode: 410
			});
		});

		it('throws 410 when max_uses is reached', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id, { maxUses: 1, usedCount: 1 });

			await expect(getInviteInfo(invite.token, testDb.db)).rejects.toMatchObject({
				statusCode: 410
			});
		});

		it('throws 404 for a token whose project was deleted', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id);
			await testDb.db.project.delete({ where: { id: project.id } });

			// Cascaded delete removes the invite too
			await expect(getInviteInfo(invite.token, testDb.db)).rejects.toMatchObject({
				statusCode: 404
			});
		});
	});

	// ── claimInvite — happy path ───────────────────────────────────────────

	describe('claimInvite — happy path', () => {
		it('returns the projectId and increments used_count', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id);

			const projectId = await claimInvite(invite.token, testDb.db);

			expect(projectId).toBe(project.id);
			const updated = await testDb.db.inviteLink.findUnique({ where: { token: invite.token } });
			expect(updated!.usedCount).toBe(1);
		});

		it('increments used_count on each successful claim (unlimited link)', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id, { maxUses: null });

			await claimInvite(invite.token, testDb.db);
			await claimInvite(invite.token, testDb.db);

			const updated = await testDb.db.inviteLink.findUnique({ where: { token: invite.token } });
			expect(updated!.usedCount).toBe(2);
		});
	});

	// ── claimInvite — non-happy path ──────────────────────────────────────

	describe('claimInvite — non-happy path', () => {
		it('throws 404 for an unknown token', async () => {
			await expect(claimInvite('no-such-token', testDb.db)).rejects.toMatchObject({
				statusCode: 404
			});
		});

		it('throws 410 for an expired token', async () => {
			const project = await seedProject(testDb.db);
			const pastDate = new Date(Date.now() - 60_000);
			const invite = await seedInvite(testDb.db, project.id, { expiresAt: pastDate });

			await expect(claimInvite(invite.token, testDb.db)).rejects.toMatchObject({
				statusCode: 410
			});
		});

		it('throws 410 when max_uses is reached', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id, { maxUses: 1, usedCount: 1 });

			await expect(claimInvite(invite.token, testDb.db)).rejects.toMatchObject({
				statusCode: 410
			});
		});

		it('does not increment used_count on a rejected claim (expired)', async () => {
			const project = await seedProject(testDb.db);
			const pastDate = new Date(Date.now() - 60_000);
			const invite = await seedInvite(testDb.db, project.id, { expiresAt: pastDate });

			await claimInvite(invite.token, testDb.db).catch(() => {});

			const updated = await testDb.db.inviteLink.findUnique({ where: { token: invite.token } });
			expect(updated!.usedCount).toBe(0);
		});

		it('does not increment used_count on a rejected claim (max uses exceeded)', async () => {
			const project = await seedProject(testDb.db);
			const invite = await seedInvite(testDb.db, project.id, { maxUses: 1, usedCount: 1 });

			await claimInvite(invite.token, testDb.db).catch(() => {});

			const updated = await testDb.db.inviteLink.findUnique({ where: { token: invite.token } });
			expect(updated!.usedCount).toBe(1);
		});

		it('throws 404 for a malformed / random token', async () => {
			await expect(claimInvite('🔥not-a-real-token', testDb.db)).rejects.toMatchObject({
				statusCode: 404
			});
		});
	});

	// ── createInvite ───────────────────────────────────────────────────────

	describe('createInvite', () => {
		it('creates an invite link with the specified role and maxUses', async () => {
			const project = await seedProject(testDb.db);
			const invite = await createInvite(
				{ projectId: project.id, role: 'SUBMITTER', maxUses: 5 },
				testDb.db
			);

			expect(invite.token).toBeTruthy();
			expect(invite.role).toBe('SUBMITTER');
			expect(invite.maxUses).toBe(5);
			expect(invite.usedCount).toBe(0);
		});

		it('creates an unlimited invite when maxUses is null', async () => {
			const project = await seedProject(testDb.db);
			const invite = await createInvite(
				{ projectId: project.id, role: 'MODERATOR', maxUses: null },
				testDb.db
			);

			expect(invite.maxUses).toBeNull();
		});
	});
});
