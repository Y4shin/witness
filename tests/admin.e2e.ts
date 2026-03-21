import { test, expect } from '@playwright/test';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'test-admin-password';

// ── helpers ────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: import('@playwright/test').Page) {
	await page.goto('/admin/login');
	await page.fill('[name=password]', ADMIN_PASSWORD);
	await page.locator('button[type=submit]').click();
	await expect(page).toHaveURL('/admin');
}

async function createProject(page: import('@playwright/test').Page, name: string) {
	await page.fill('[name=name]', name);
	await page.locator('button:text("Create")').click();
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('admin console', () => {
	// ── GET /admin — unauthenticated ───────────────────────────────────────

	test('accessing /admin without auth redirects to login', async ({ page }) => {
		await page.goto('/admin');
		await expect(page).toHaveURL('/admin/login');
	});

	// ── POST /admin/login — non-happy path ─────────────────────────────────

	test('wrong password shows an error', async ({ page }) => {
		await page.goto('/admin/login');
		await page.fill('[name=password]', 'definitely-wrong-password');
		await page.click('[type=submit]');
		await expect(page.locator('[role=alert]')).toBeVisible();
		await expect(page).toHaveURL('/admin/login');
	});

	// ── POST /admin/login — happy path ─────────────────────────────────────

	test('correct password grants access to admin console', async ({ page }) => {
		await loginAsAdmin(page);
		await expect(page.locator('h1')).toHaveText('Admin console');
	});

	// ── createProject — happy path ─────────────────────────────────────────

	test('creating a project shows an invite link and QR code', async ({ page }) => {
		await loginAsAdmin(page);
		await createProject(page, 'E2E Test Project');

		const inviteLink = page.locator('[data-testid=invite-link]');
		await expect(inviteLink).toBeVisible();
		await expect(inviteLink).toContainText('/invite/');

		await expect(page.locator('[data-testid=qr-code] canvas')).toBeVisible({ timeout: 10000 });
	});

	test('created project appears in the project list', async ({ page }) => {
		await loginAsAdmin(page);
		await createProject(page, 'Listed Project');

		await expect(page.locator('li', { hasText: 'Listed Project' })).toBeVisible();
	});

	// ── createProject — non-happy path ────────────────────────────────────

	test('creating a project with an empty name shows a validation error', async ({ page }) => {
		await loginAsAdmin(page);

		// Remove HTML5 required so the form can be submitted empty, then click Create
		await page.evaluate(() => {
			const input = document.querySelector<HTMLInputElement>('[name=name]');
			if (input) input.removeAttribute('required');
		});
		await page.locator('button:text("Create")').click();

		await expect(page.locator('[role=alert]')).toBeVisible();
	});

	// ── deleteProject — happy path ─────────────────────────────────────────

	test('deleting a project removes it from the list', async ({ page }) => {
		await loginAsAdmin(page);

		// Use a unique name to avoid matching stale rows from prior test runs
		const uniqueName = `To Be Deleted ${Date.now()}`;
		await createProject(page, uniqueName);
		const row = page.locator('li', { hasText: uniqueName });
		await expect(row).toBeVisible();
		// Wait for Svelte hydration to complete (form POST causes full page reload;
		// the row may be visible in the SSR HTML before onclick handlers are attached)
		await page.waitForLoadState('networkidle');

		// Click delete, wait for confirm to appear, then confirm — scoped to the specific row
		await row.locator('[data-testid=delete-project]').click();
		await expect(row.locator('[data-testid=confirm-delete-project]')).toBeVisible({ timeout: 5000 });
		await row.locator('[data-testid=confirm-delete-project]').click();

		await expect(page.locator('li', { hasText: uniqueName })).not.toBeVisible();
	});

	// ── deleteProject — non-happy path ────────────────────────────────────

	test('attempting to delete a non-existent project returns 404', async ({ page }) => {
		await loginAsAdmin(page);

		// Submit the deleteProject action with a fake id via page.request (shares admin cookie)
		const res = await page.request.post('/admin?/deleteProject', {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			data: 'id=00000000-0000-0000-0000-000000000000'
		});
		expect(res.status()).toBe(404);
	});

	// ── invite link — single-use ───────────────────────────────────────────

	test('admin invite link is single-use: a fully-used link shows 410', async ({ page, request }) => {
		// Seed a project and an already-exhausted invite link (usedCount === maxUses)
		const seedProject = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Single Use Project' }
		});
		const { projectId } = await seedProject.json();

		const seedInvite = await request.post('/api/_test/seed', {
			data: { type: 'inviteLink', projectId, maxUses: 1, usedCount: 1 }
		});
		const { token } = await seedInvite.json();

		// Visiting an exhausted link should return 410
		const res = await page.request.get(`/invite/${token}`);
		expect(res.status()).toBe(410);
	});

	// ── sign out ───────────────────────────────────────────────────────────

	test('signing out redirects to login', async ({ page }) => {
		await loginAsAdmin(page);
		await page.locator('button:text("Sign out")').click();
		await expect(page).toHaveURL('/admin/login');
	});
});
