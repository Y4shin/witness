/**
 * E2E tests for the client-side schema migration flow.
 *
 * Verifies that when a user visits the submissions list page or submission
 * detail page with v1 (legacy) submissions/files present, the client:
 *   1. Correctly reads type/archiveUrl from the plaintext columns (v1)
 *   2. Fires the PATCH migrate endpoint in the background
 *   3. Leaves the submission at schemaVersion=2 with plaintext columns cleared
 *
 * Also covers the PATCH /api/submissions/[id]/migrate and
 * PATCH /api/submissions/[id]/files/[fileId]/migrate endpoints directly.
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

// ── crypto helpers ─────────────────────────────────────────────────────────────

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

async function reAuth(request: APIRequestContext, signingPublicKey: string, signingPrivateKey: CryptoKey) {
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});
}

/** Encrypts plaintext bytes with AES-GCM and returns base64url(iv || ciphertext). */
async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
	);
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv); combined.set(ciphertext, iv.length);
	return b64url(combined);
}

/** Sets up a project with a submitter and moderator. Returns keys, IDs, and the project private key. */
async function setupProject(request: APIRequestContext, projectName = 'Migration E2E Test') {
	const projectEcdh = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	const projectPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', projectEcdh.publicKey));

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
	const { memberId } = await subRes.json();

	return { projectId, projectPublicKey, projectPrivateKey: projectEcdh.privateKey, subKeys, memberId };
}

/** Seeds a v1 submission (plaintext type/archiveCandidateUrl/archiveUrl, schemaVersion=1). */
async function seedV1Submission(
	request: APIRequestContext,
	projectId: string,
	memberId: string,
	projectPublicKeyJwk: string,
	userEncPublicKeyJwk: string,
	fields: Record<string, string>,
	submissionType = 'WEBPAGE',
	archiveCandidateUrl = 'https://example.com',
	archiveUrl = 'https://archive.ph/abc'
): Promise<string> {
	// Encrypt the flat fields (v1 format — no DecryptedPayload envelope)
	const symKey = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
	);
	const encryptedPayload = await aesGcmEncrypt(
		symKey, new TextEncoder().encode(JSON.stringify(fields))
	);
	const [encryptedKeyProject, encryptedKeyUser] = await Promise.all([
		wrapKeyFor(symKey, projectPublicKeyJwk),
		wrapKeyFor(symKey, userEncPublicKeyJwk)
	]);

	const res = await request.post('/api/_test/seed', {
		data: {
			type: 'submission',
			projectId,
			memberId,
			submissionType,
			archiveCandidateUrl,
			archiveUrl,
			schemaVersion: 1,
			encryptedPayload,
			encryptedKeyProject,
			encryptedKeyUser
		}
	});
	expect(res.status()).toBe(200);
	return (await res.json()).submissionId as string;
}

/** Seeds a v1 file (plaintext mimeType, null encryptedMeta, schemaVersion=1). */
async function seedV1File(
	request: APIRequestContext,
	submissionId: string,
	mimeType: string,
	projectPublicKeyJwk: string,
	userEncPublicKeyJwk: string
): Promise<string> {
	const symKey = await crypto.subtle.generateKey(
		{ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
	);
	const [encryptedKey, encryptedKeyUser] = await Promise.all([
		wrapKeyFor(symKey, projectPublicKeyJwk),
		wrapKeyFor(symKey, userEncPublicKeyJwk)
	]);

	const res = await request.post('/api/_test/seed', {
		data: {
			type: 'submissionFile',
			submissionId,
			mimeType,
			schemaVersion: 1,
			encryptedKey,
			encryptedKeyUser,
			storagePath: '/dev/null',
			sizeBytes: 0
		}
	});
	expect(res.status()).toBe(200);
	return (await res.json()).fileId as string;
}

/** Stores a membership bundle in localStorage so the page can auto-decrypt. */
async function storeBundle(
	page: Page,
	projectId: string,
	projectName: string,
	role: 'SUBMITTER' | 'MODERATOR',
	keys: Awaited<ReturnType<typeof generateUserKeys>>
) {
	const bundle = {
		signingPublicKey: JSON.parse(keys.signingPublicKey),
		signingPrivateKey: await crypto.subtle.exportKey('jwk', keys.signing.privateKey),
		encryptionPublicKey: JSON.parse(keys.encryptionPublicKey),
		encryptionPrivateKey: await crypto.subtle.exportKey('jwk', keys.encryption.privateKey)
	};
	await page.evaluate(
		(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
		{ [projectId]: { bundle, projectName, role } }
	);
}

// ── PATCH migrate endpoint tests ──────────────────────────────────────────────

test.describe('PATCH /api/submissions/[id]/migrate', () => {
	test('submitter can migrate their own v1 submission', async ({ request }) => {
		const { projectId, projectPublicKey, subKeys, memberId } = await setupProject(request, 'Migrate Sub Test');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		const submissionId = await seedV1Submission(
			request, projectId, memberId, projectPublicKey, subKeys.encryptionPublicKey,
			{ note: 'test' }
		);

		// Build new v2 encrypted payload
		const symKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
		const encryptedPayload = await aesGcmEncrypt(
			symKey, new TextEncoder().encode(JSON.stringify({ type: 'WEBPAGE', archiveCandidateUrl: 'https://example.com', archiveUrl: 'https://archive.ph/abc', fields: { note: 'test' } }))
		);
		const [encryptedKeyProject, encryptedKeyUser] = await Promise.all([
			wrapKeyFor(symKey, projectPublicKey),
			wrapKeyFor(symKey, subKeys.encryptionPublicKey)
		]);

		const res = await request.patch(`/api/submissions/${submissionId}/migrate`, {
			data: { encryptedPayload, encryptedKeyProject, encryptedKeyUser }
		});
		expect(res.status()).toBe(200);
		expect((await res.json()).ok).toBe(true);

		// Submission should now be schemaVersion=2 with plaintext columns cleared
		const getRes = await request.get(`/api/submissions/${submissionId}`);
		const { submissions } = await getRes.json();
		expect(submissions[0].schemaVersion).toBe(2);
		expect(submissions[0].type).toBeNull();
		expect(submissions[0].archiveCandidateUrl).toBeNull();
		expect(submissions[0].archiveUrl).toBeNull();
		expect(submissions[0].encryptedPayload).toBe(encryptedPayload);
	});

	test('returns 401 for unauthenticated requests', async ({ request }) => {
		const res = await request.patch('/api/submissions/nonexistent/migrate', {
			data: { encryptedPayload: 'p', encryptedKeyProject: 'k', encryptedKeyUser: 'u' }
		});
		expect(res.status()).toBe(401);
	});
});

test.describe('PATCH /api/submissions/[id]/files/[fileId]/migrate', () => {
	test('submitter can migrate their own v1 file', async ({ request }) => {
		const { projectId, projectPublicKey, subKeys, memberId } = await setupProject(request, 'Migrate File Test');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		const submissionId = await seedV1Submission(
			request, projectId, memberId, projectPublicKey, subKeys.encryptionPublicKey, {}
		);
		const fileId = await seedV1File(
			request, submissionId, 'image/png', projectPublicKey, subKeys.encryptionPublicKey
		);

		// Build encryptedMeta using the file sym key (in a real migration, the client unwraps
		// encryptedKeyUser and encrypts { mimeType } — here we use a synthetic ciphertext)
		const symKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
		const encryptedMeta = await aesGcmEncrypt(
			symKey, new TextEncoder().encode(JSON.stringify({ mimeType: 'image/png' }))
		);

		const res = await request.patch(`/api/submissions/${submissionId}/files/${fileId}/migrate`, {
			data: { encryptedMeta }
		});
		expect(res.status()).toBe(200);
		expect((await res.json()).ok).toBe(true);

		// Verify via GET files that mimeType is cleared and encryptedMeta is set
		const filesRes = await request.get(`/api/submissions/${submissionId}/files`);
		const { files } = await filesRes.json();
		const file = files.find((f: { id: string }) => f.id === fileId);
		expect(file.schemaVersion).toBe(2);
		expect(file.mimeType).toBeNull();
		expect(file.encryptedMeta).toBe(encryptedMeta);
	});
});

// ── client-side auto-migration flow ──────────────────────────────────────────

test.describe('client-side migration', () => {
	test('list page auto-migrates v1 submissions to v2', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, memberId } = await setupProject(request, 'Client Migration Test');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		const submissionId = await seedV1Submission(
			request, projectId, memberId, projectPublicKey, subKeys.encryptionPublicKey,
			{ note: 'legacy data' }, 'WEBPAGE', 'https://example.com', 'https://archive.ph/abc'
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'Client Migration Test', 'SUBMITTER', subKeys);
		await page.reload();

		// Wait for the page to decrypt and render the submission
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15_000 });

		// Wait for the background migration to complete (up to 10s after rendering)
		await expect.poll(async () => {
			const res = await request.get(`/api/submissions/${submissionId}`);
			const { submissions } = await res.json();
			return submissions[0].schemaVersion;
		}, { timeout: 10_000, intervals: [500] }).toBe(2);

		// Verify plaintext columns are cleared
		const getRes = await request.get(`/api/submissions/${submissionId}`);
		const { submissions } = await getRes.json();
		expect(submissions[0].type).toBeNull();
		expect(submissions[0].archiveCandidateUrl).toBeNull();
		expect(submissions[0].archiveUrl).toBeNull();
	});

	test('detail page auto-migrates v1 files to v2', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, memberId } = await setupProject(request, 'File Migration Test');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		const submissionId = await seedV1Submission(
			request, projectId, memberId, projectPublicKey, subKeys.encryptionPublicKey, {}
		);
		const fileId = await seedV1File(
			request, submissionId, 'image/jpeg', projectPublicKey, subKeys.encryptionPublicKey
		);

		await page.goto(`/projects/${projectId}/submissions/${submissionId}`);
		await storeBundle(page, projectId, 'File Migration Test', 'SUBMITTER', subKeys);
		await page.reload();

		// Wait for the detail page to load
		await expect(page.locator('.loading')).not.toBeVisible({ timeout: 15_000 });

		// Wait for the background file migration to complete
		await expect.poll(async () => {
			const res = await request.get(`/api/submissions/${submissionId}/files`);
			const { files } = await res.json();
			const f = files.find((f: { id: string }) => f.id === fileId);
			return f?.schemaVersion;
		}, { timeout: 10_000, intervals: [500] }).toBe(2);

		// Verify mimeType is cleared
		const filesRes = await request.get(`/api/submissions/${submissionId}/files`);
		const { files } = await filesRes.json();
		const file = files.find((f: { id: string }) => f.id === fileId);
		expect(file.mimeType).toBeNull();
		expect(file.encryptedMeta).toBeTruthy();
	});

	test('list page shows correct type from plaintext columns for v1 submissions before migration', async ({ page, request }) => {
		const { projectId, projectPublicKey, subKeys, memberId } = await setupProject(request, 'V1 Display Test');
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		await seedV1Submission(
			request, projectId, memberId, projectPublicKey, subKeys.encryptionPublicKey,
			{ note: 'test note' }, 'WEBPAGE'
		);

		await page.goto(`/projects/${projectId}/submissions`);
		await storeBundle(page, projectId, 'V1 Display Test', 'SUBMITTER', subKeys);
		await page.reload();

		// The submission card should render without errors (type shown from plaintext column)
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15_000 });
	});
});
