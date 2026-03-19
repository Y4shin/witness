import { test, expect } from '@playwright/test';

// ── crypto helpers ─────────────────────────────────────────────────────────

async function generateProjectKeyPair() {
	const pair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
	return {
		publicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)),
		privateKey: pair.privateKey
	};
}

// Seeds a project (with public key) and a SUBMITTER invite for it.
// Returns { projectId, inviteToken }.
async function seedProjectWithInvite(
	request: import('@playwright/test').APIRequestContext,
	projectName: string,
	role: 'SUBMITTER' | 'MODERATOR' = 'SUBMITTER'
) {
	const project = await generateProjectKeyPair();
	const seedRes = await request.post('/api/_test/seed', {
		data: { type: 'project', name: projectName, publicKey: project.publicKey }
	});
	expect(seedRes.status()).toBe(200);
	const { projectId } = await seedRes.json();

	const inviteRes = await request.post('/api/_test/seed', {
		data: { type: 'inviteLink', projectId, role, maxUses: 1 }
	});
	expect(inviteRes.status()).toBe(200);
	const { token: inviteToken } = await inviteRes.json();

	return { projectId, inviteToken };
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('registration flow', () => {
	test('completing registration stores keys in localStorage and redirects to dashboard', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Test Project');

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await page.waitForSelector('form', { timeout: 5000 });

		await page.getByLabel('Name').fill('Alice');
		await page.getByLabel('Contact').fill('alice@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		await page.waitForURL('/dashboard', { timeout: 10000 });
		await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();

		const storedKeys = await page.evaluate(() => localStorage.getItem('rt:keys'));
		expect(storedKeys).not.toBeNull();
		const keys = JSON.parse(storedKeys!);
		expect(keys.signingPublicKey).toBeTruthy();
		expect(keys.signingPrivateKey).toBeTruthy();
		expect(keys.encryptionPublicKey).toBeTruthy();
		expect(keys.encryptionPrivateKey).toBeTruthy();
	});

	test('registration does not store keys if POST /api/users fails', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Fail Project');

		await page.route('/api/users', (route) =>
			route.fulfill({ status: 500, body: JSON.stringify({ message: 'Server error' }) })
		);

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Bob');
		await page.getByLabel('Contact').fill('bob@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
		expect(page.url()).toContain('/auth');

		const storedKeys = await page.evaluate(() => localStorage.getItem('rt:keys'));
		expect(storedKeys).toBeNull();
	});

	test('shows validation context when there is no projectId', async ({ page }) => {
		await page.goto('/auth');
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
	});

	test('returns to register form after start over clears localStorage', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Start Over Project');
		const authUrl = `/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`;

		// First, register successfully
		await page.goto(authUrl);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Carol');
		await page.getByLabel('Contact').fill('carol@example.com');
		await page.getByRole('button', { name: 'Register' }).click();
		await page.waitForURL('/dashboard', { timeout: 10000 });

		// Clear localStorage to simulate key loss
		await page.evaluate(() => localStorage.removeItem('rt:keys'));

		// Visit auth again with same URL — should show register form, not auto-login
		await page.goto(authUrl);
		await page.waitForSelector('form', { timeout: 5000 });
		await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
	});

	test('visiting /dashboard without a session redirects to /auth', async ({ page }) => {
		await page.goto('/dashboard');
		await expect(page).toHaveURL(/\/auth/);
	});

	test('submitting with an empty name keeps the button disabled', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Validation Project');

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await page.waitForSelector('form', { timeout: 5000 });

		await page.getByLabel('Contact').fill('dave@example.com');
		await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});

	test('submitting with an empty contact keeps the button disabled', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Validation Project 2');

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await page.waitForSelector('form', { timeout: 5000 });

		await page.getByLabel('Name').fill('Dave');
		await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});
});
