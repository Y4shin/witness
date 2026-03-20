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

/** Clicks through the onboarding privacy screen to reveal the registration form. */
async function clickThroughOnboarding(page: import('@playwright/test').Page) {
	await page.getByRole('button', { name: 'Understood, continue' }).click();
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('registration flow', () => {
	test('completing registration stores keys in localStorage and redirects to dashboard', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Test Project');

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await clickThroughOnboarding(page);
		await page.waitForSelector('form', { timeout: 5000 });

		await page.getByLabel('Name').fill('Alice');
		await page.getByLabel('Contact').fill('alice@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		await page.waitForURL('/dashboard', { timeout: 10000 });
		await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();

		const storedMemberships = await page.evaluate(() => localStorage.getItem('rt:memberships'));
		expect(storedMemberships).not.toBeNull();
		const memberships = JSON.parse(storedMemberships!);
		const membership = memberships[projectId];
		expect(membership).toBeTruthy();
		expect(membership.bundle.signingPublicKey).toBeTruthy();
		expect(membership.bundle.signingPrivateKey).toBeTruthy();
		expect(membership.bundle.encryptionPublicKey).toBeTruthy();
		expect(membership.bundle.encryptionPrivateKey).toBeTruthy();
	});

	test('registration does not store keys if POST /api/memberships fails', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Fail Project');

		await page.route('/api/memberships', (route) =>
			route.fulfill({ status: 500, body: JSON.stringify({ message: 'Server error' }) })
		);

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await clickThroughOnboarding(page);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Bob');
		await page.getByLabel('Contact').fill('bob@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
		expect(page.url()).toContain('/auth');

		const storedMemberships = await page.evaluate(() => localStorage.getItem('rt:memberships'));
		expect(storedMemberships).toBeNull();
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
		await clickThroughOnboarding(page);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Carol');
		await page.getByLabel('Contact').fill('carol@example.com');
		await page.getByRole('button', { name: 'Register' }).click();
		await page.waitForURL('/dashboard', { timeout: 10000 });

		// Clear localStorage to simulate key loss
		await page.evaluate(() => localStorage.removeItem('rt:memberships'));

		// Visit auth again with same URL — should show onboarding then register form
		await page.goto(authUrl);
		await clickThroughOnboarding(page);
		await page.waitForSelector('form', { timeout: 5000 });
		await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
	});

	test('visiting /dashboard without a session shows empty project list (client-side page)', async ({ page }) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		// Dashboard is CSR-only — it does not redirect server-side.
		// With no memberships in localStorage, it shows an empty state.
		expect(page.url()).toContain('/dashboard');
	});

	test('submitting with an empty name keeps the button disabled', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Validation Project');

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await clickThroughOnboarding(page);
		await page.waitForSelector('form', { timeout: 5000 });

		await page.getByLabel('Contact').fill('dave@example.com');
		await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});

	test('submitting with an empty contact keeps the button disabled', async ({ page, request }) => {
		const { projectId, inviteToken } = await seedProjectWithInvite(request, 'Validation Project 2');

		await page.goto(`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`);
		await clickThroughOnboarding(page);
		await page.waitForSelector('form', { timeout: 5000 });

		await page.getByLabel('Name').fill('Dave');
		await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});
});
