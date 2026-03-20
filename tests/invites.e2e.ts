import { test, expect } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

async function seedProject(request: import('@playwright/test').APIRequestContext, name = 'Invite Test Project') {
	const res = await request.post('/api/_test/seed', { data: { type: 'project', name } });
	const { projectId } = await res.json();
	return projectId as string;
}

async function seedInvite(
	request: import('@playwright/test').APIRequestContext,
	projectId: string,
	overrides: { maxUses?: number; usedCount?: number; expiresAt?: string } = {}
) {
	const res = await request.post('/api/_test/seed', {
		data: { type: 'inviteLink', projectId, ...overrides }
	});
	const { token } = await res.json();
	return token as string;
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('invite link flows', () => {
	// ── GET /api/invites/[token] — happy path ──────────────────────────────

	test('GET /api/invites/[token] returns project info for a valid token', async ({ request }) => {
		const projectId = await seedProject(request, 'Info Project');
		const token = await seedInvite(request, projectId);

		const res = await request.get(`/api/invites/${token}`);
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.projectId).toBe(projectId);
		expect(body.projectName).toBe('Info Project');
		expect(body.role).toBe('MODERATOR');
	});

	test('GET /api/invites/[token] does not consume the invite', async ({ request }) => {
		const projectId = await seedProject(request);
		const token = await seedInvite(request, projectId, { maxUses: 1 });

		// Calling info endpoint twice should not exhaust the single-use link
		await request.get(`/api/invites/${token}`);
		const second = await request.get(`/api/invites/${token}`);
		expect(second.status()).toBe(200);
	});

	// ── GET /api/invites/[token] — non-happy path ─────────────────────────

	test('GET /api/invites/[token] returns 404 for an unknown token', async ({ request }) => {
		const res = await request.get('/api/invites/no-such-token');
		expect(res.status()).toBe(404);
	});

	test('GET /api/invites/[token] returns 410 for an expired token', async ({ request }) => {
		const projectId = await seedProject(request);
		const pastDate = new Date(Date.now() - 60_000).toISOString();
		const token = await seedInvite(request, projectId, { expiresAt: pastDate });

		const res = await request.get(`/api/invites/${token}`);
		expect(res.status()).toBe(410);
	});

	test('GET /api/invites/[token] returns 410 for a used-up token', async ({ request }) => {
		const projectId = await seedProject(request);
		const token = await seedInvite(request, projectId, { maxUses: 1, usedCount: 1 });

		const res = await request.get(`/api/invites/${token}`);
		expect(res.status()).toBe(410);
	});

	// ── /invite/[token] page — happy path ─────────────────────────────────

	test('visiting a valid invite link redirects to the onboarding flow', async ({ page, request }) => {
		const projectId = await seedProject(request, 'Onboarding Project');
		const token = await seedInvite(request, projectId);

		await page.goto(`/invite/${token}`);
		await expect(page).toHaveURL(new RegExp(`/auth\\?projectId=${projectId}`));
		// Auth page shows onboarding privacy screen first; click through to register form
		await page.getByRole('button', { name: 'Understood, continue' }).click();
		await expect(page.locator('h1')).toContainText('Create your account');
	});

	// ── /invite/[token] page — non-happy path ─────────────────────────────

	test('visiting an expired invite link shows a "link expired" message', async ({ page, request }) => {
		const projectId = await seedProject(request);
		const pastDate = new Date(Date.now() - 60_000).toISOString();
		const token = await seedInvite(request, projectId, { expiresAt: pastDate });

		await page.goto(`/invite/${token}`);
		await expect(page.locator('text=expired')).toBeVisible();
	});

	test('visiting a used-up invite link shows a "link no longer valid" message', async ({ page, request }) => {
		const projectId = await seedProject(request);
		const token = await seedInvite(request, projectId, { maxUses: 1, usedCount: 1 });

		await page.goto(`/invite/${token}`);
		await expect(page.locator('text=no longer valid')).toBeVisible();
	});

	test('visiting a non-existent invite token shows a 404 message', async ({ page }) => {
		await page.goto('/invite/definitely-does-not-exist');
		await expect(page.locator('text=not found')).toBeVisible();
	});
});
