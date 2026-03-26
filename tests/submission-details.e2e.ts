/**
 * E2E tests for:
 *  - Admin button on home page and dashboard
 *  - GET /api/submissions/[id] access control
 *  - Submission details page (View details link, field display, file list, download)
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

// ── crypto helpers ──────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
	s = s.replace(/-/g, '+').replace(/_/g, '/');
	while (s.length % 4) s += '=';
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
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
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('witness-key-wrap') },
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

async function reAuth(request: APIRequestContext, signingPublicKey: string, signingPrivateKey: CryptoKey) {
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});
}

/** Creates a project + submitter + moderator. Returns keys and IDs. */
async function setupProject(request: APIRequestContext, projectName = 'Details E2E Test') {
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

	const subKeys = await generateUserKeys();
	const subRes = await request.post('/api/_test/seed', {
		data: {
			type: 'member', projectId,
			signingPublicKey: subKeys.signingPublicKey,
			encryptionPublicKey: subKeys.encryptionPublicKey,
			role: 'SUBMITTER'
		}
	});
	expect(subRes.status()).toBe(200);

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

	return {
		projectId,
		projectPublicKey,
		projectPrivateKey: projectEcdh.privateKey,
		subKeys,
		modKeys,
		encryptedProjectPrivateKey
	};
}

/** Posts an encrypted submission and returns its ID. */
async function postSubmission(
	request: APIRequestContext,
	projectPublicKeyJwk: string,
	userEncryptionPublicKeyJwk: string,
	signingPrivateKey: CryptoKey,
	projectId: string,
	payload: Record<string, string>
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
	const sha256bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes));
	const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
	message.set(nonceBytes); message.set(sha256bytes, nonceBytes.length);
	const sigBytes = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, message
	);

	const res = await request.post('/api/submissions', {
		data: {
			projectId, nonce, type: 'WEBPAGE',
			encryptedPayload, encryptedKeyProject, encryptedKeyUser,
			submitterSignature: b64url(new Uint8Array(sigBytes))
		}
	});
	expect(res.status()).toBe(201);
	return (await res.json()).submissionId as string;
}

/** Uploads an encrypted file to a submission. Returns fileId. */
async function uploadFile(
	request: APIRequestContext,
	submissionId: string,
	projectPublicKeyJwk: string,
	userEncryptionPublicKeyJwk: string,
	content: Uint8Array,
	mimeType: string,
	fieldName: string
): Promise<string> {
	const symKey = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, content.buffer as ArrayBuffer)
	);
	const encBytes = new Uint8Array(iv.length + ciphertext.length);
	encBytes.set(iv); encBytes.set(ciphertext, iv.length);
	const encryptedData = b64url(encBytes);

	const [encryptedKey, encryptedKeyUser] = await Promise.all([
		wrapKeyFor(symKey, projectPublicKeyJwk),
		wrapKeyFor(symKey, userEncryptionPublicKeyJwk)
	]);

	const res = await request.post(`/api/submissions/${submissionId}/files`, {
		data: { fieldName, mimeType, encryptedData, encryptedKey, encryptedKeyUser }
	});
	expect(res.status()).toBe(201);
	return (await res.json()).fileId as string;
}

/** Stores a membership bundle in localStorage so the page can auto-decrypt. */
async function storeBundle(
	page: Page,
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
	await page.evaluate(
		(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
		{ [projectId]: membership }
	);
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe('admin button visibility', () => {
	test('home page has a link to /admin', async ({ page }) => {
		await page.goto('/');
		const link = page.locator('a[href="/admin"]');
		await expect(link).toBeVisible();
	});

	test('dashboard has a link to /admin', async ({ page, request }) => {
		const { projectId, subKeys } = await setupProject(request, 'Admin Button Test');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		await page.goto('/dashboard');
		await storeBundle(page, projectId, 'Admin Button Test', 'SUBMITTER', subKeys);
		await page.reload();

		const link = page.locator('a[href="/admin"]');
		await expect(link).toBeVisible();
	});
});

test.describe('GET /api/submissions/[id]', () => {
	test('submitter can fetch their own submission', async ({ request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request);
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'my evidence' }
		);

		const res = await request.get(`/api/submissions/${submissionId}`);
		expect(res.status()).toBe(200);
		const { submissions } = await res.json();
		expect(submissions).toHaveLength(1);
		expect(submissions[0].id).toBe(submissionId);
		expect(submissions[0].encryptedPayload).toBeTruthy();
		expect(submissions[0].encryptedKeyUser).toBeTruthy();
	});

	test('MODERATOR can fetch any submission in their project', async ({ request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys } = await setupProject(request);

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'secret' }
		);

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);
		const res = await request.get(`/api/submissions/${submissionId}`);
		expect(res.status()).toBe(200);
		const { submissions } = await res.json();
		expect(submissions[0].id).toBe(submissionId);
	});

	test('submitter cannot fetch another member\'s submission', async ({ request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request);

		// Post a submission as the submitter
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'private' }
		);

		// Seed a second submitter and authenticate as them
		const sub2Keys = await generateUserKeys();
		await request.post('/api/_test/seed', {
			data: {
				type: 'member', projectId,
				signingPublicKey: sub2Keys.signingPublicKey,
				encryptionPublicKey: sub2Keys.encryptionPublicKey,
				role: 'SUBMITTER'
			}
		});
		await reAuth(request, sub2Keys.signingPublicKey, sub2Keys.signing.privateKey);

		const res = await request.get(`/api/submissions/${submissionId}`);
		expect(res.status()).toBe(403);
	});

	test('unauthenticated request returns 401', async ({ request }) => {
		const res = await request.get('/api/submissions/00000000-0000-0000-0000-000000000000');
		expect(res.status()).toBe(401);
	});

	test('non-existent submission returns 404', async ({ request }) => {
		const { subKeys } = await setupProject(request);
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		const res = await request.get('/api/submissions/00000000-0000-0000-0000-000000000000');
		expect(res.status()).toBe(404);
	});

	test('member of a different project cannot fetch the submission', async ({ request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Project A');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'project A' }
		);

		// Member of a different project
		const { subKeys: otherKeys } = await setupProject(request, 'Project B');
		await reAuth(request, otherKeys.signingPublicKey, otherKeys.signing.privateKey);

		const res = await request.get(`/api/submissions/${submissionId}`);
		expect(res.status()).toBe(403);
	});
});

test.describe('submission details page', () => {
	test('"View details" link appears on each submission card', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Details Link Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'my submission' }
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Details Link Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('link', { name: /view details/i })).toBeVisible();
	});

	test('clicking "View details" navigates to the submission details page', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Details Nav Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'nav test' }
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Details Nav Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });
		await page.getByRole('link', { name: /view details/i }).click();

		await expect(page).toHaveURL(`/projects/${projectId}/submissions/${submissionId}`);
	});

	test('details page decrypts and displays submission fields', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Details Fields Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { description: 'hello from details test' }
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Details Fields Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });
		await page.getByRole('link', { name: /view details/i }).click();

		// Wait for decryption to complete (loading spinner disappears)
		await expect(page.locator('.loading')).not.toBeVisible({ timeout: 15000 });

		// Decrypted field value should appear
		await expect(page.getByText('hello from details test')).toBeVisible();
	});

	test('details page shows "No files attached" when submission has no files', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Details No Files Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'no files' }
		);

		await page.goto(`/projects/${projectId}/submissions/${submissionId}`);
		await storeBundle(page, projectId, 'Details No Files Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.locator('.loading')).not.toBeVisible({ timeout: 15000 });
		await expect(page.getByText(/no files attached/i)).toBeVisible();
	});

	test('details page shows Download button for an uploaded file', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Details File Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'has file' }
		);

		// Upload a small fake image file
		const fakeImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
		await uploadFile(
			request, submissionId,
			projectPublicKey, subKeys.encryptionPublicKey,
			fakeImageBytes, 'image/png', 'evidence'
		);

		await page.goto(`/projects/${projectId}/submissions/${submissionId}`);
		await storeBundle(page, projectId, 'Details File Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.locator('.loading')).not.toBeVisible({ timeout: 15000 });

		// Download button should be visible for the file
		await expect(page.getByRole('button', { name: /download/i })).toBeVisible();
		// Preview button should be visible since mimeType is image/
		await expect(page.getByRole('button', { name: /preview/i })).toBeVisible();
	});

	test('clicking Download triggers a file download', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys } = await setupProject(request, 'Details Download Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { note: 'download me' }
		);

		const fakeBytes = new Uint8Array([1, 2, 3, 4, 5]);
		await uploadFile(
			request, submissionId,
			projectPublicKey, subKeys.encryptionPublicKey,
			fakeBytes, 'application/octet-stream', 'evidence'
		);

		await page.goto(`/projects/${projectId}/submissions/${submissionId}`);
		await storeBundle(page, projectId, 'Details Download Test', 'SUBMITTER', subKeys);
		await page.reload();

		await expect(page.locator('.loading')).not.toBeVisible({ timeout: 15000 });
		await expect(page.getByRole('button', { name: /download/i })).toBeVisible();

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: /download/i }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBeTruthy();
	});

	test('MODERATOR can view details and see decrypted fields', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, modKeys, encryptedProjectPrivateKey } =
			await setupProject(request, 'Mod Details Test');

		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);
		const submissionId = await postSubmission(
			request, projectPublicKey, subKeys.encryptionPublicKey,
			subKeys.signing.privateKey, projectId, { witness: 'moderator can read this' }
		);

		await reAuth(request, modKeys.signingPublicKey, modKeys.signing.privateKey);

		await page.goto(`/projects/${projectId}/submissions/${submissionId}`);
		await storeBundle(page, projectId, 'Mod Details Test', 'MODERATOR', modKeys, encryptedProjectPrivateKey);
		await page.reload();

		await expect(page.locator('.loading')).not.toBeVisible({ timeout: 15000 });
		await expect(page.getByText('moderator can read this')).toBeVisible();
	});
});
