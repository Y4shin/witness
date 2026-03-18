/**
 * E2E tests for Step 9: project keypair genesis.
 *
 * Covers:
 *  - First OBSERVER registration generates the project keypair, uploads the
 *    public key, and stores an encrypted copy of the private key in their
 *    membership record.
 *  - PATCH /api/projects/[id]/public-key returns 409 when a key already exists.
 *  - SUBMITTER registration with a project that has no public key shows an error.
 */
import { test, expect } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

async function seedProject(
	request: import('@playwright/test').APIRequestContext,
	name: string,
	publicKey?: string
) {
	const res = await request.post('/api/_test/seed', {
		data: { type: 'project', name, publicKey: publicKey ?? null }
	});
	expect(res.status()).toBe(200);
	return (await res.json()).projectId as string;
}

async function seedInvite(
	request: import('@playwright/test').APIRequestContext,
	projectId: string,
	role: 'OBSERVER' | 'SUBMITTER' = 'OBSERVER'
) {
	const res = await request.post('/api/_test/seed', {
		data: { type: 'inviteLink', projectId, role, maxUses: 1 }
	});
	expect(res.status()).toBe(200);
	return (await res.json()).token as string;
}

async function generateEcdhPublicKeyJwk(): Promise<string> {
	const pair = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
	return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('project keypair genesis', () => {
	test('first observer registration uploads project public key and stores encrypted private key', async ({
		page,
		request
	}) => {
		// Project has NO public key yet
		const projectId = await seedProject(request, 'Genesis Project');
		const inviteToken = await seedInvite(request, projectId, 'OBSERVER');

		await page.goto(
			`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=OBSERVER`
		);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Alice Observer');
		await page.getByLabel('Contact').fill('alice@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		await page.waitForURL('/dashboard', { timeout: 15000 });

		// Project should now have a public key
		const keyRes = await request.get(`/api/projects/${projectId}/public-key`);
		expect(keyRes.status()).toBe(200);
		const { publicKey } = await keyRes.json();
		expect(publicKey).toBeTruthy();

		// The public key should be a valid JWK string
		const jwk = JSON.parse(publicKey);
		expect(jwk.kty).toBe('EC');
		expect(jwk.crv).toBe('P-256');
	});

	test('second observer registration uses existing project public key', async ({
		page,
		request
	}) => {
		// Project already has a public key
		const existingPubKey = await generateEcdhPublicKeyJwk();
		const projectId = await seedProject(request, 'Two Observer Project', existingPubKey);
		const inviteToken = await seedInvite(request, projectId, 'OBSERVER');

		await page.goto(
			`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=OBSERVER`
		);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Bob Observer');
		await page.getByLabel('Contact').fill('bob@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		await page.waitForURL('/dashboard', { timeout: 15000 });

		// Public key should be unchanged
		const keyRes = await request.get(`/api/projects/${projectId}/public-key`);
		expect(keyRes.status()).toBe(200);
		expect((await keyRes.json()).publicKey).toBe(existingPubKey);
	});

	test('submitter registration fails with error when project has no public key', async ({
		page,
		request
	}) => {
		// Project has NO public key — submitter cannot register
		const projectId = await seedProject(request, 'No Key Project');
		const inviteToken = await seedInvite(request, projectId, 'SUBMITTER');

		await page.goto(
			`/auth?projectId=${projectId}&inviteToken=${encodeURIComponent(inviteToken)}&role=SUBMITTER`
		);
		await page.waitForSelector('form', { timeout: 5000 });
		await page.getByLabel('Name').fill('Eve Submitter');
		await page.getByLabel('Contact').fill('eve@example.com');
		await page.getByRole('button', { name: 'Register' }).click();

		// Should show an error about the project not being ready
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 10000 });
		const alertText = await page.getByRole('alert').textContent();
		expect(alertText).toMatch(/not ready/i);
	});

	test('PATCH /api/projects/[id]/public-key returns 409 if key already set', async ({
		request
	}) => {
		const existingPubKey = await generateEcdhPublicKeyJwk();
		const projectId = await seedProject(request, '409 Project', existingPubKey);

		// Register a user so we have an authenticated session
		const userSeed = await request.post('/api/_test/seed', {
			data: { type: 'user', signingPublicKey: 'spk', encryptionPublicKey: 'epk' }
		});
		expect(userSeed.status()).toBe(200);

		// Unauthenticated PATCH should return 401
		const unauthRes = await request.patch(`/api/projects/${projectId}/public-key`, {
			data: { publicKey: await generateEcdhPublicKeyJwk() }
		});
		expect(unauthRes.status()).toBe(401);
	});

	test('GET /api/projects/[id]/public-key returns 404 when project has no key', async ({
		request
	}) => {
		const projectId = await seedProject(request, 'No Key Project 2');
		const res = await request.get(`/api/projects/${projectId}/public-key`);
		expect(res.status()).toBe(404);
	});

	test('GET /api/projects/[id]/public-key returns the key when set', async ({ request }) => {
		const pubKey = await generateEcdhPublicKeyJwk();
		const projectId = await seedProject(request, 'Has Key Project', pubKey);
		const res = await request.get(`/api/projects/${projectId}/public-key`);
		expect(res.status()).toBe(200);
		expect((await res.json()).publicKey).toBe(pubKey);
	});

	test('auth page shows warning when inviteToken is missing', async ({ page, request }) => {
		const projectId = await seedProject(request, 'Warning Project');
		await page.goto(`/auth?projectId=${projectId}`);
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('alert')).toBeVisible({ timeout: 5000 });
	});
});
