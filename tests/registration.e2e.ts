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

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('registration flow', () => {
	test('completing registration stores keys in localStorage and redirects to dashboard', async ({ page }) => {
		// Seed a project with a public key
		const project = await generateProjectKeyPair();
		const seedRes = await page.request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Test Project', publicKey: project.publicKey }
		});
		expect(seedRes.status()).toBe(200);
		const { projectId } = await seedRes.json();

		// Navigate to the auth page with project context
		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForSelector('form', { timeout: 5000 });

		// Fill in the registration form
		await page.getByLabel('Name').fill('Alice');
		await page.getByLabel('Contact').fill('alice@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		// Should redirect to dashboard
		await page.waitForURL('/dashboard', { timeout: 10000 });
		await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

		// Keys should be in localStorage
		const storedKeys = await page.evaluate(() => localStorage.getItem('rt:keys'));
		expect(storedKeys).not.toBeNull();
		const keys = JSON.parse(storedKeys!);
		expect(keys.signingPublicKey).toBeTruthy();
		expect(keys.signingPrivateKey).toBeTruthy();
		expect(keys.encryptionPublicKey).toBeTruthy();
		expect(keys.encryptionPrivateKey).toBeTruthy();
	});

	test('registration does not store keys if POST /api/users fails', async ({ page }) => {
		const project = await generateProjectKeyPair();
		const seedRes = await page.request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Fail Project', publicKey: project.publicKey }
		});
		const { projectId } = await seedRes.json();

		// Intercept and fail the user registration request
		await page.route('/api/users', (route) => route.fulfill({ status: 500, body: JSON.stringify({ message: 'Server error' }) }));

		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Bob');
		await page.getByLabel('Contact').fill('bob@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		// Should show an error, not navigate away
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
		expect(page.url()).toContain('/auth');

		// Keys must NOT be stored
		const storedKeys = await page.evaluate(() => localStorage.getItem('rt:keys'));
		expect(storedKeys).toBeNull();
	});

	test('shows validation context when there is no projectId', async ({ page }) => {
		await page.goto('/auth');
		// Wait for SSR-skip: the page loads as a client-only shell
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
	});

	test('returns to register form after start over clears localStorage', async ({ page }) => {
		// First, register successfully
		const project = await generateProjectKeyPair();
		const seedRes = await page.request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Start Over Project', publicKey: project.publicKey }
		});
		const { projectId } = await seedRes.json();

		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Carol');
		await page.getByLabel('Contact').fill('carol@example.com');
		await page.getByRole('button', { name: 'Register' }).click();
		await page.waitForURL('/dashboard', { timeout: 10000 });

		// Clear localStorage to simulate key loss
		await page.evaluate(() => localStorage.removeItem('rt:keys'));

		// Visit auth again — should show register form, not auto-login
		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForSelector('form', { timeout: 5000 });
		await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
	});

	test('visiting /dashboard without a session redirects to /auth', async ({ page }) => {
		await page.goto('/dashboard');
		await expect(page).toHaveURL(/\/auth/);
	});

	test('submitting with an empty name keeps the button disabled', async ({ page }) => {
		const project = await generateProjectKeyPair();
		const seedRes = await page.request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Validation Project', publicKey: project.publicKey }
		});
		const { projectId } = await seedRes.json();

		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForSelector('form', { timeout: 5000 });

		// Only fill contact, leave name empty
		await page.getByLabel('Contact').fill('dave@example.com');
		await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});

	test('submitting with an empty contact keeps the button disabled', async ({ page }) => {
		const project = await generateProjectKeyPair();
		const seedRes = await page.request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Validation Project 2', publicKey: project.publicKey }
		});
		const { projectId } = await seedRes.json();

		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForSelector('form', { timeout: 5000 });

		// Only fill name, leave contact empty
		await page.getByLabel('Name').fill('Dave');
		await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
	});
});
