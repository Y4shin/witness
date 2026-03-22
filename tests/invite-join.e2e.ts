/**
 * E2E tests for the complete invite-link join flow.
 *
 * Each join attempt uses a SEPARATE browser context (browser.newContext()) to
 * simulate a genuinely different user/device — no shared cookies or localStorage
 * with any previously seeded moderator.
 *
 * Scenarios:
 *  - MODERATOR joins as first moderator (project has no public key yet)
 *  - MODERATOR joins when a public key already exists (second moderator)
 *  - SUBMITTER joins (project already has a public key)
 *  - Expired invite link → error page
 *  - Used-up (maxUses exhausted) invite link → error page
 *  - Non-existent token → error page
 *  - Revoked invite link → error page (same as non-existent after deletion)
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

// ── seed helpers ─────────────────────────────────────────────────────────────

async function seedProject(
	request: APIRequestContext,
	name: string,
	publicKey?: string
): Promise<string> {
	const res = await request.post('/api/_test/seed', {
		data: { type: 'project', name, ...(publicKey ? { publicKey } : {}) }
	});
	expect(res.status()).toBe(200);
	const { projectId } = await res.json();
	return projectId as string;
}

async function seedInvite(
	request: APIRequestContext,
	projectId: string,
	options: { role?: 'SUBMITTER' | 'MODERATOR'; maxUses?: number; usedCount?: number; expiresAt?: string } = {}
): Promise<string> {
	const res = await request.post('/api/_test/seed', {
		data: {
			type: 'inviteLink',
			projectId,
			role: options.role ?? 'SUBMITTER',
			...(options.maxUses !== undefined ? { maxUses: options.maxUses } : {}),
			...(options.usedCount !== undefined ? { usedCount: options.usedCount } : {}),
			...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
		}
	});
	expect(res.status()).toBe(200);
	const { token } = await res.json();
	return token as string;
}

/** Generate a P-256 ECDH public key JWK string for seeding projects that need a key. */
async function generateProjectPublicKeyJwk(): Promise<string> {
	const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveKey',
		'deriveBits'
	]);
	return JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey));
}

/**
 * Seed a MODERATOR member and authenticate as them so the request context
 * carries a valid session cookie. Used to perform privileged API calls
 * (like revoking an invite) without going through the UI.
 */
async function seedAndAuthModerator(
	request: APIRequestContext,
	projectId: string
): Promise<void> {
	const signing = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify']
	);
	const encryption = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
	const signingPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey));
	const encryptionPublicKey = JSON.stringify(
		await crypto.subtle.exportKey('jwk', encryption.publicKey)
	);

	await request.post('/api/_test/seed', {
		data: { type: 'member', projectId, signingPublicKey, encryptionPublicKey, role: 'MODERATOR' }
	});

	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		signing.privateKey,
		new TextEncoder().encode(nonce)
	);
	const b64url = (bytes: Uint8Array) =>
		btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	await request.post('/api/auth/verify', {
		data: {
			signingPublicKey,
			nonce,
			signature: b64url(new Uint8Array(sig))
		}
	});
}

// ── join flow helper ─────────────────────────────────────────────────────────

/**
 * Complete the join/onboarding UI flow in the given page.
 * Clicks through the privacy screen and fills the registration form.
 */
async function completeJoinFlow(
	page: import('@playwright/test').Page,
	token: string,
	name = 'Test User',
	contact = 'test@example.com'
): Promise<void> {
	await page.goto(`/invite/${token}`);

	// /invite/[token] server-redirects to /auth — wait for it
	await page.waitForURL(/\/auth\?/);

	// Privacy onboarding screen
	await expect(page.getByRole('button', { name: 'Understood, continue' })).toBeVisible();
	await page.getByRole('button', { name: 'Understood, continue' }).click();

	// Registration form
	await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
	await page.getByLabel('Name').fill(name);
	await page.getByLabel('Contact').fill(contact);
	await page.getByRole('button', { name: 'Register' }).click();

	// After successful registration the user is redirected to /dashboard
	await page.waitForURL('/dashboard', { timeout: 15_000 });
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('invite join flow', () => {
	// ── successful join scenarios ────────────────────────────────────────────

	test('MODERATOR joins as first moderator (generates project public key)', async ({
		browser,
		request
	}) => {
		// Project has NO public key yet — the joining moderator must create one.
		const projectId = await seedProject(request, 'First Mod Project');
		const token = await seedInvite(request, projectId, { role: 'MODERATOR', maxUses: 1 });

		// Fresh browser context = different user/device
		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await completeJoinFlow(joinerPage, token);
			await expect(joinerPage).toHaveURL('/dashboard');
		} finally {
			await joinerCtx.close();
		}
	});

	test('MODERATOR joins when a public key already exists (second moderator)', async ({
		browser,
		request
	}) => {
		// Project already has a public key (as if a first moderator already registered).
		const publicKey = await generateProjectPublicKeyJwk();
		const projectId = await seedProject(request, 'Second Mod Project', publicKey);
		const token = await seedInvite(request, projectId, { role: 'MODERATOR', maxUses: 2 });

		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await completeJoinFlow(joinerPage, token);
			await expect(joinerPage).toHaveURL('/dashboard');
		} finally {
			await joinerCtx.close();
		}
	});

	test('SUBMITTER joins successfully', async ({ browser, request }) => {
		// Submitters require the project public key to already exist.
		const publicKey = await generateProjectPublicKeyJwk();
		const projectId = await seedProject(request, 'Submitter Join Project', publicKey);
		const token = await seedInvite(request, projectId, { role: 'SUBMITTER', maxUses: 1 });

		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await completeJoinFlow(joinerPage, token);
			await expect(joinerPage).toHaveURL('/dashboard');
		} finally {
			await joinerCtx.close();
		}
	});

	test('invite is consumed after a successful SUBMITTER join (maxUses=1)', async ({
		browser,
		request
	}) => {
		const publicKey = await generateProjectPublicKeyJwk();
		const projectId = await seedProject(request, 'Single Use Project', publicKey);
		const token = await seedInvite(request, projectId, { role: 'SUBMITTER', maxUses: 1 });

		// First join succeeds
		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();
		try {
			await completeJoinFlow(joinerPage, token, 'User One', 'user1@example.com');
		} finally {
			await joinerCtx.close();
		}

		// Second attempt with the same token should show "no longer valid" error
		const secondCtx = await browser.newContext();
		const secondPage = await secondCtx.newPage();
		try {
			await secondPage.goto(`/invite/${token}`);
			await expect(secondPage.locator('text=no longer valid')).toBeVisible();
		} finally {
			await secondCtx.close();
		}
	});

	// ── error scenarios ───────────────────────────────────────────────────────

	test('expired invite link shows "expired" error page', async ({ browser, request }) => {
		const projectId = await seedProject(request, 'Expired Token Project');
		const pastDate = new Date(Date.now() - 60_000).toISOString();
		const token = await seedInvite(request, projectId, { expiresAt: pastDate });

		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await joinerPage.goto(`/invite/${token}`);
			await expect(joinerPage.locator('text=expired')).toBeVisible();
		} finally {
			await joinerCtx.close();
		}
	});

	test('used-up invite link shows "no longer valid" error page', async ({ browser, request }) => {
		const projectId = await seedProject(request, 'Used Up Token Project');
		const token = await seedInvite(request, projectId, { maxUses: 1, usedCount: 1 });

		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await joinerPage.goto(`/invite/${token}`);
			await expect(joinerPage.locator('text=no longer valid')).toBeVisible();
		} finally {
			await joinerCtx.close();
		}
	});

	test('non-existent invite token shows "not found" error page', async ({ browser }) => {
		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await joinerPage.goto('/invite/definitely-does-not-exist-xyz');
			await expect(joinerPage.locator('text=not found')).toBeVisible();
		} finally {
			await joinerCtx.close();
		}
	});

	test('revoked invite link shows "not found" error page', async ({ browser, request }) => {
		// Create project + moderator member to authenticate with, then create and revoke an invite.
		const publicKey = await generateProjectPublicKeyJwk();
		const projectId = await seedProject(request, 'Revoke Test Project', publicKey);
		await seedAndAuthModerator(request, projectId);

		// Create a new invite via the authenticated API
		const createRes = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER', maxUses: 5 }
		});
		expect(createRes.status()).toBe(201);
		const { token } = await createRes.json();

		// Revoke the invite
		const revokeRes = await request.delete(`/api/invites/${token}`);
		expect(revokeRes.status()).toBe(200);

		// Joining user should see 404 (revoked = hard deleted)
		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await joinerPage.goto(`/invite/${token}`);
			await expect(joinerPage.locator('text=not found')).toBeVisible();
		} finally {
			await joinerCtx.close();
		}
	});

	// ── re-login with stored keys ─────────────────────────────────────────────

	test('returning user is auto-logged in when revisiting /auth with stored keys', async ({
		browser,
		request
	}) => {
		const publicKey = await generateProjectPublicKeyJwk();
		const projectId = await seedProject(request, 'Returning User Project', publicKey);
		const token = await seedInvite(request, projectId, { role: 'SUBMITTER', maxUses: 5 });

		// Do the initial join
		const joinerCtx = await browser.newContext();
		const joinerPage = await joinerCtx.newPage();

		try {
			await completeJoinFlow(joinerPage, token);
			await expect(joinerPage).toHaveURL('/dashboard');

			// Revisit /auth with the same projectId — keys are in localStorage,
			// so the page should skip onboarding and auto-login, then redirect.
			await joinerPage.goto(`/auth?projectId=${projectId}`);
			// Auto-login redirects either to /dashboard or the project page.
			await joinerPage.waitForURL(new RegExp(`/dashboard|/projects/${projectId}`), {
				timeout: 10_000
			});
		} finally {
			await joinerCtx.close();
		}
	});
});
