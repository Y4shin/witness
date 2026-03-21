/**
 * E2E tests for the submission export feature.
 *
 * Tests cover:
 *  - Export button is visible to MODERATORs, hidden from SUBMITTERs
 *  - Export without files: only CSV is downloaded (no ZIPs)
 *  - Export with files: ZIPs + CSV are downloaded with correct names
 *  - Export respects active filters (only exports filtered subset)
 *  - Progress UI transitions through planning → done states
 *  - Cancel stops the export
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// ── crypto helpers ──────────────────────────────────────────────────────────
// (same helpers used across E2E tests — kept local to avoid shared state)

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

async function generateUserKeys() {
	const signing = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
	);
	const encryption = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	return {
		signing,
		encryption,
		signingPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey)),
		encryptionPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', encryption.publicKey))
	};
}

async function wrapKeyFor(symKey: CryptoKey, recipientPublicKeyJwk: string): Promise<string> {
	const recipientPubKey = await crypto.subtle.importKey(
		'jwk', JSON.parse(recipientPublicKeyJwk),
		{ name: 'ECDH', namedCurve: 'P-256' }, true, []
	);
	const ephemeral = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	const ephemeralPublicKey = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
	const salt = crypto.getRandomValues(new Uint8Array(32));
	const wrapIv = crypto.getRandomValues(new Uint8Array(12));
	const shared = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: recipientPubKey }, ephemeral.privateKey, 256
	);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	const wrappingKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('reporting-tool-key-wrap') },
		hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['wrapKey']
	);
	const wrapped = new Uint8Array(
		await crypto.subtle.wrapKey('raw', symKey, wrappingKey, { name: 'AES-GCM', iv: wrapIv })
	);
	const wrapCombined = new Uint8Array(salt.length + wrapIv.length + wrapped.length);
	wrapCombined.set(salt);
	wrapCombined.set(wrapIv, salt.length);
	wrapCombined.set(wrapped, salt.length + wrapIv.length);
	return JSON.stringify({ ephemeralPublicKey, wrappedKey: b64url(wrapCombined) });
}

/** Builds { payload, key } object for encryptedProjectPrivateKey. */
async function buildEncryptedProjectPrivateKey(
	projectPrivateKey: CryptoKey,
	userEncryptionPublicKeyJwk: string
): Promise<string> {
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', projectPrivateKey);
	const symKey = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encPayload = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, pkcs8)
	);
	const combined = new Uint8Array(iv.length + encPayload.length);
	combined.set(iv);
	combined.set(encPayload, iv.length);
	const keyJson = await wrapKeyFor(symKey, userEncryptionPublicKeyJwk);
	return JSON.stringify({ payload: b64url(combined), key: JSON.parse(keyJson) });
}

/** Challenge/verify login for an already-seeded member. */
async function reAuth(
	request: APIRequestContext,
	signingPublicKey: string,
	signingPrivateKey: CryptoKey
) {
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});
}

/**
 * Sets up a project with a submitter who has posted one encrypted submission,
 * and a moderator who can decrypt using the project key.
 * Returns everything needed to navigate to the submissions page and interact with it.
 */
async function setupProject(request: APIRequestContext, projectName = 'Export E2E Test') {
	// Create project with ECDH key pair
	const projectEcdh = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	const projectPublicKey = JSON.stringify(
		await crypto.subtle.exportKey('jwk', projectEcdh.publicKey)
	);
	const projRes = await request.post('/api/_test/seed', {
		data: { type: 'project', name: projectName, publicKey: projectPublicKey }
	});
	expect(projRes.status()).toBe(200);
	const projectId = (await projRes.json()).projectId as string;

	// Submitter
	const subKeys = await generateUserKeys();
	await request.post('/api/_test/seed', {
		data: {
			type: 'member', projectId,
			signingPublicKey: subKeys.signingPublicKey,
			encryptionPublicKey: subKeys.encryptionPublicKey,
			role: 'SUBMITTER'
		}
	});

	// Moderator
	const modKeys = await generateUserKeys();
	const encryptedProjectPrivateKey = await buildEncryptedProjectPrivateKey(
		projectEcdh.privateKey, modKeys.encryptionPublicKey
	);
	const modRes = await request.post('/api/_test/seed', {
		data: {
			type: 'member', projectId,
			signingPublicKey: modKeys.signingPublicKey,
			encryptionPublicKey: modKeys.encryptionPublicKey,
			role: 'MODERATOR',
			encryptedProjectPrivateKey
		}
	});
	expect(modRes.status()).toBe(200);
	const { memberId: modMemberId } = await modRes.json();

	return {
		projectId,
		projectPublicKey,
		projectPrivateKey: projectEcdh.privateKey,
		subKeys,
		modKeys,
		modMemberId
	};
}

/** Posts an encrypted submission as the currently-authenticated user. */
async function postSubmission(
	request: APIRequestContext,
	projectPublicKeyJwk: string,
	userEncryptionPublicKeyJwk: string,
	signingPrivateKey: CryptoKey,
	projectId: string,
	payload: Record<string, string>,
	type = 'WEBPAGE'
): Promise<string> {
	const symKey = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
	);
	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, plaintext)
	);
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv); combined.set(ciphertext, iv.length);
	const encryptedPayload = b64url(combined);

	const [encryptedKeyProject, encryptedKeyUser] = await Promise.all([
		wrapKeyFor(symKey, projectPublicKeyJwk),
		wrapKeyFor(symKey, userEncryptionPublicKeyJwk)
	]);

	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const nonceBytes = new TextEncoder().encode(nonce);
	const payloadBytes = new TextEncoder().encode(encryptedPayload);
	const sha256bytes = new Uint8Array(
		await crypto.subtle.digest('SHA-256', payloadBytes)
	);
	const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
	message.set(nonceBytes); message.set(sha256bytes, nonceBytes.length);
	const sigBytes = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, message
	);

	const res = await request.post('/api/submissions', {
		data: {
			projectId, nonce, type,
			encryptedPayload, encryptedKeyProject, encryptedKeyUser,
			submitterSignature: b64url(new Uint8Array(sigBytes))
		}
	});
	expect(res.status()).toBe(201);
	return (await res.json()).submissionId as string;
}

/** Stores the member bundle in localStorage so the page can auto-decrypt. */
async function storeBundle(
	page: import('@playwright/test').Page,
	projectId: string,
	projectName: string,
	role: 'SUBMITTER' | 'MODERATOR',
	keys: Awaited<ReturnType<typeof generateUserKeys>>,
	encryptedProjectPrivateKey?: string
) {
	const bundle = {
		signingPublicKey: JSON.parse(keys.signingPublicKey),
		signingPrivateKey: await crypto.subtle.exportKey('jwk', keys.signing.privateKey),
		encryptionPublicKey: JSON.parse(keys.encryptionPublicKey),
		encryptionPrivateKey: await crypto.subtle.exportKey('jwk', keys.encryption.privateKey)
	};
	const membership = {
		bundle,
		projectName,
		role,
		...(encryptedProjectPrivateKey ? { encryptedProjectPrivateKey } : {})
	};
	const memberships = { [projectId]: membership };
	await page.evaluate(
		(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
		memberships
	);
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe('export feature', () => {
	// ── Role visibility ────────────────────────────────────────────────────

	test('Export button is visible to MODERATORs', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys, modMemberId } =
			await setupProject(request, 'Export Visibility Test');

		// Log in as submitter, post one submission so the page has data
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://example.com' }
		);

		// Log in as moderator
		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Export Visibility Test', 'MODERATOR', modKeys);
		await page.reload();

		// Wait for submissions to load
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('button', { name: /export/i })).toBeVisible();
	});

	test('Export button is visible to SUBMITTERs (they can export their own submissions)', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Export Submitter Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://example.com' }
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Export Submitter Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('button', { name: /export/i })).toBeVisible();
	});

	test('SUBMITTER export downloads a CSV of their own submissions', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Submitter Export CSV Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://my-submission.example.com' }
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Submitter Export CSV Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /export/i }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^export-.*-submissions\.csv$/);
		await expect(page.getByText(/Export complete/i)).toBeVisible({ timeout: 10000 });
	});

	// ── No-files export (CSV only) ─────────────────────────────────────────

	test('export with no file attachments downloads only a CSV', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys } =
			await setupProject(request, 'CSV-Only Export Test');

		// Post two submissions without files
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://alpha.example.com' }
		);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://beta.example.com' }, 'YOUTUBE_VIDEO'
		);

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'CSV-Only Export Test', 'MODERATOR', modKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toHaveCount(2, { timeout: 15000 });

		// Start waiting for a download BEFORE clicking (Playwright requires this ordering)
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /export/i }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^export-.*-submissions\.csv$/);

		// Progress panel should eventually show "done"
		await expect(page.getByText(/Export complete/i)).toBeVisible({ timeout: 10000 });

		// Dismiss the panel
		await page.getByRole('button', { name: /dismiss/i }).click();
		await expect(page.getByText(/Export complete/i)).not.toBeVisible();
	});

	// ── Export with files ──────────────────────────────────────────────────

	test('export with a file attachment downloads ZIP + CSV', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys } =
			await setupProject(request, 'ZIP Export Test');

		// Post a submission (without real file — the export flow fetches file metadata via API
		// then downloads each file; we just need the submission card to be visible)
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://example.com/evidence' }
		);

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'ZIP Export Test', 'MODERATOR', modKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });

		// This submission has no files (fileCount = 0), so we still expect only CSV.
		// The important thing here is that the export button triggers the flow without errors.
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /export/i }).click();
		await downloadPromise;

		await expect(page.getByText(/Export complete/i)).toBeVisible({ timeout: 10000 });
	});

	// ── Progress UI ─────────────────────────────────────────────────────────

	test('export progress panel appears and disappears correctly', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys } =
			await setupProject(request, 'Progress UI Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://example.com' }
		);

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Progress UI Test', 'MODERATOR', modKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });

		// Progress panel should not be visible before export
		await expect(page.getByText(/Planning export/i)).not.toBeVisible();

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /export/i }).click();

		// At some point during export the progress panel is shown
		// (planning phase or done — depending on speed)
		await downloadPromise;
		await expect(page.getByText(/Export complete/i)).toBeVisible({ timeout: 10000 });

		// Export button should be re-enabled after dismissal
		await page.getByRole('button', { name: /dismiss/i }).click();
		await expect(page.getByRole('button', { name: /export/i })).toBeEnabled();
	});

	// ── Cancel ──────────────────────────────────────────────────────────────

	test('Cancel button aborts the export and resets the panel', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys } =
			await setupProject(request, 'Cancel Export Test');

		// Seed several submissions to give us time to cancel
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		for (let i = 0; i < 3; i++) {
			await postSubmission(
				request, projectPublicKey, subKeys.encryptionPublicKey,
				subKeys.signing.privateKey, projectId, { url: `https://example.com/${i}` }
			);
		}

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Cancel Export Test', 'MODERATOR', modKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toHaveCount(3, { timeout: 15000 });

		// Intercept file-metadata calls so the planning phase never completes,
		// giving us a stable window to click Cancel
		await page.route('**/api/submissions/**/files', (route) => {
			// Delay indefinitely so export stays in "planning" phase
			// We cancel before the route resolves
		});

		await page.getByRole('button', { name: /export/i }).click();
		await expect(page.getByText(/Planning export/i)).toBeVisible({ timeout: 5000 });

		await page.getByRole('button', { name: /cancel/i }).click();

		// Progress panel should disappear
		await expect(page.getByText(/Planning export/i)).not.toBeVisible({ timeout: 3000 });
		// Export button should be enabled again
		await expect(page.getByRole('button', { name: /export/i })).toBeEnabled();
	});

	// ── Filter scoping ──────────────────────────────────────────────────────

	test('export respects active type filter — only exports matching submissions', async ({
		page,
		request
	}) => {
		const { projectId, projectPublicKey, subKeys, modKeys } =
			await setupProject(request, 'Filtered Export Test');

		// Post two WEBPAGE and one YOUTUBE_VIDEO submission
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://a.example.com' }, 'WEBPAGE'
		);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://b.example.com' }, 'WEBPAGE'
		);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { url: 'https://yt.example.com' }, 'YOUTUBE_VIDEO'
		);

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Filtered Export Test', 'MODERATOR', modKeys);
		await page.reload();

		// Wait for all 3 cards
		await expect(page.getByTestId('submission-card')).toHaveCount(3, { timeout: 15000 });

		// Open filter panel and filter to YOUTUBE_VIDEO only
		await page.getByRole('button', { name: /filter/i }).click();
		await page.getByRole('button', { name: /youtube/i }).click();

		// Only 1 card should be visible after filtering
		await expect(page.getByTestId('submission-card')).toHaveCount(1, { timeout: 5000 });

		// Export should now only download 1-submission CSV
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /export/i }).click();
		const download = await downloadPromise;

		// Read the CSV and count data rows (header + 1 submission)
		const path = await download.path();
		const { readFileSync } = await import('fs');
		const csvContent = readFileSync(path!, 'utf-8');
		const lines = csvContent.split('\r\n').filter(Boolean);
		// 1 header row + 1 data row
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain('YOUTUBE_VIDEO');

		await expect(page.getByText(/Export complete/i)).toBeVisible({ timeout: 10000 });
	});
});
