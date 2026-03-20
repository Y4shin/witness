/**
 * E2E tests for Step 13: submission views.
 *
 * Tests cover GET /api/projects/[id]/submissions:
 *  - submitter sees only their own submissions; decrypted values match original
 *  - MODERATOR sees all submissions; can decrypt with project key
 *  - unauthenticated returns 401
 *  - non-member returns 403
 *  - submitter does not see other users' submissions
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// ── crypto helpers ─────────────────────────────────────────────────────────

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
	const signingPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey));
	const encryptionPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', encryption.publicKey));
	return { signing, encryption, signingPublicKey, encryptionPublicKey };
}

/** Wraps a symmetric key for an ECDH recipient public key. Returns JSON string. */
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
	const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientPubKey }, ephemeral.privateKey, 256);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	const wrappingKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('reporting-tool-key-wrap') },
		hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['wrapKey']
	);
	const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', symKey, wrappingKey, { name: 'AES-GCM', iv: wrapIv }));
	const wrapCombined = new Uint8Array(salt.length + wrapIv.length + wrapped.length);
	wrapCombined.set(salt);
	wrapCombined.set(wrapIv, salt.length);
	wrapCombined.set(wrapped, salt.length + wrapIv.length);
	return JSON.stringify({ ephemeralPublicKey, wrappedKey: b64url(wrapCombined) });
}

/**
 * Authenticates a user via challenge/verify.
 * Creates the user (and optionally project + membership) via seed endpoints.
 * Returns the keys, projectId, and projectPublicKey.
 */
async function setupAndAuthSubmitter(
	request: APIRequestContext,
	existingProjectId?: string,
	existingProjectPublicKey?: string
) {
	const keys = await generateUserKeys();

	let projectId = existingProjectId;
	let projectPublicKey = existingProjectPublicKey;
	let projectPrivateKey: CryptoKey | undefined;

	if (!projectId) {
		const projectEcdh = await crypto.subtle.generateKey(
			{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
		);
		projectPrivateKey = projectEcdh.privateKey;
		projectPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', projectEcdh.publicKey));
		const projRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'View Test', publicKey: projectPublicKey }
		});
		expect(projRes.status()).toBe(200);
		projectId = (await projRes.json()).projectId;
	}

	const memberRes = await request.post('/api/_test/seed', {
		data: { type: 'member', projectId, signingPublicKey: keys.signingPublicKey, encryptionPublicKey: keys.encryptionPublicKey, role: 'SUBMITTER' }
	});
	expect(memberRes.status()).toBe(200);
	const { memberId } = await memberRes.json();

	// Challenge/verify
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		keys.signing.privateKey,
		new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey: keys.signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});

	return { keys, projectId: projectId!, projectPublicKey: projectPublicKey!, projectPrivateKey, memberId };
}

/**
 * Posts a submission using the full crypto protocol.
 * The `request` cookie jar must have an authenticated session.
 */
async function postSubmission(
	request: APIRequestContext,
	projectPublicKeyJwk: string,
	userEncryptionPublicKeyJwk: string,
	signingPrivateKey: CryptoKey,
	projectId: string,
	payload: Record<string, string>
): Promise<string> {
	const symKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, plaintext));
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv);
	combined.set(ciphertext, iv.length);
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
	message.set(nonceBytes);
	message.set(sha256bytes, nonceBytes.length);
	const sigBytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, message);

	const res = await request.post('/api/submissions', {
		data: { projectId, nonce, type: 'WEBPAGE', encryptedPayload, encryptedKeyProject, encryptedKeyUser, submitterSignature: b64url(new Uint8Array(sigBytes)) }
	});
	expect(res.status()).toBe(201);
	return (await res.json()).submissionId as string;
}

/** Re-authenticates a user (challenge/verify). Sets the session cookie on `request`. */
async function reAuth(request: APIRequestContext, signingPublicKey: string, signingPrivateKey: CryptoKey) {
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		signingPrivateKey,
		new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});
}

/** Builds encryptedProjectPrivateKey (MODERATOR format) for a given project private key and user encryption public key. */
async function buildEncryptedProjectPrivateKey(
	projectPrivateKey: CryptoKey,
	userEncryptionPublicKeyJwk: string
): Promise<string> {
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', projectPrivateKey);
	const symKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encPayload = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, pkcs8));
	const payloadCombined = new Uint8Array(iv.length + encPayload.length);
	payloadCombined.set(iv);
	payloadCombined.set(encPayload, iv.length);

	const keyJson = await wrapKeyFor(symKey, userEncryptionPublicKeyJwk);
	return JSON.stringify({ payload: b64url(payloadCombined), key: JSON.parse(keyJson) });
}

/** Decrypts a submission payload using the user's encryption private key. */
async function decryptWithUserKey(
	encryptedPayload: string,
	encryptedKeyUser: string,
	userEncryptionPrivateKey: CryptoKey
): Promise<Record<string, string>> {
	const encKey = JSON.parse(encryptedKeyUser) as { ephemeralPublicKey: JsonWebKey; wrappedKey: string };
	const ephPub = await crypto.subtle.importKey('jwk', encKey.ephemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
	const wrapCombined = b64urlDecode(encKey.wrappedKey);
	const salt = wrapCombined.slice(0, 32);
	const wrapIv = wrapCombined.slice(32, 44);
	const wrapped = wrapCombined.slice(44);
	const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephPub }, userEncryptionPrivateKey, 256);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	const wrappingKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('reporting-tool-key-wrap') },
		hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']
	);
	const symKey = await crypto.subtle.unwrapKey('raw', wrapped, wrappingKey, { name: 'AES-GCM', iv: wrapIv }, { name: 'AES-GCM' }, true, ['decrypt']);
	const combined = b64urlDecode(encryptedPayload);
	const aesIv = combined.slice(0, 12);
	const ciphertext = combined.slice(12);
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: aesIv }, symKey, ciphertext);
	return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
}

/** Decrypts a submission payload using the project private key. */
async function decryptWithProjectKey(
	encryptedPayload: string,
	encryptedKeyProject: string,
	projectPrivateKey: CryptoKey
): Promise<Record<string, string>> {
	const encKey = JSON.parse(encryptedKeyProject) as { ephemeralPublicKey: JsonWebKey; wrappedKey: string };
	const ephPub = await crypto.subtle.importKey('jwk', encKey.ephemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
	const wrapCombined = b64urlDecode(encKey.wrappedKey);
	const salt = wrapCombined.slice(0, 32);
	const wrapIv = wrapCombined.slice(32, 44);
	const wrapped = wrapCombined.slice(44);
	const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephPub }, projectPrivateKey, 256);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	const wrappingKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('reporting-tool-key-wrap') },
		hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']
	);
	const symKey = await crypto.subtle.unwrapKey('raw', wrapped, wrappingKey, { name: 'AES-GCM', iv: wrapIv }, { name: 'AES-GCM' }, true, ['decrypt']);
	const combined = b64urlDecode(encryptedPayload);
	const aesIv = combined.slice(0, 12);
	const ciphertext = combined.slice(12);
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: aesIv }, symKey, ciphertext);
	return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('submission views', () => {
	test('submitter can fetch and decrypt their own submission', async ({ request }) => {
		const { keys, projectId, projectPublicKey } = await setupAndAuthSubmitter(request);

		const payload = { message: 'hello from submitter' };
		await postSubmission(request, projectPublicKey, keys.encryptionPublicKey, keys.signing.privateKey, projectId, payload);

		const res = await request.get(`/api/projects/${projectId}/submissions`);
		expect(res.status()).toBe(200);
		const { submissions } = await res.json();
		expect(submissions).toHaveLength(1);

		// Decrypt with user key and verify plaintext matches original
		const decrypted = await decryptWithUserKey(
			submissions[0].encryptedPayload,
			submissions[0].encryptedKeyUser,
			keys.encryption.privateKey
		);
		expect(decrypted).toEqual(payload);
	});

	test('submitter only sees their own submissions (not other users\')', async ({ request }) => {
		const { keys, projectId, projectPublicKey } = await setupAndAuthSubmitter(request);
		const payload = { who: 'user1' };
		await postSubmission(request, projectPublicKey, keys.encryptionPublicKey, keys.signing.privateKey, projectId, payload);

		// Seed a second member and a raw submission for them (no real crypto needed for count test)
		const otherKeys = await generateUserKeys();
		const otherMemberRes = await request.post('/api/_test/seed', {
			data: { type: 'member', projectId, signingPublicKey: otherKeys.signingPublicKey, encryptionPublicKey: otherKeys.encryptionPublicKey, role: 'SUBMITTER' }
		});
		const { memberId: otherMemberId } = await otherMemberRes.json();
		await request.post('/api/_test/seed', {
			data: { type: 'submission', projectId, memberId: otherMemberId }
		});

		// Re-authenticate as the first submitter (seed requests above didn't change session)
		// The request fixture still has user1's session — just fetch
		const res = await request.get(`/api/projects/${projectId}/submissions`);
		expect(res.status()).toBe(200);
		const { submissions } = await res.json();
		expect(submissions).toHaveLength(1);
		const decrypted = await decryptWithUserKey(
			submissions[0].encryptedPayload,
			submissions[0].encryptedKeyUser,
			keys.encryption.privateKey
		);
		expect(decrypted.who).toBe('user1');
	});

	test('MODERATOR sees all submissions and can decrypt with project key', async ({ request }) => {
		// Step 1: Set up submitter + project (gets project private key)
		const { keys: subKeys, projectId, projectPublicKey, projectPrivateKey } = await setupAndAuthSubmitter(request);

		// Step 2: Post submission as submitter (real crypto)
		const payload = { secret: 'MODERATOR can read this' };
		await postSubmission(request, projectPublicKey, subKeys.encryptionPublicKey, subKeys.signing.privateKey, projectId, payload);

		// Step 3: Seed a MODERATOR member with the project private key encrypted for them
		const obsKeys = await generateUserKeys();
		const encryptedProjectPrivateKey = await buildEncryptedProjectPrivateKey(projectPrivateKey!, obsKeys.encryptionPublicKey);
		await request.post('/api/_test/seed', {
			data: { type: 'member', projectId, signingPublicKey: obsKeys.signingPublicKey, encryptionPublicKey: obsKeys.encryptionPublicKey, role: 'MODERATOR', encryptedProjectPrivateKey }
		});

		// Step 4: Re-authenticate as MODERATOR
		await reAuth(request, obsKeys.signingPublicKey, obsKeys.signing.privateKey);

		// Step 5: MODERATOR fetches all submissions
		const res = await request.get(`/api/projects/${projectId}/submissions`);
		expect(res.status()).toBe(200);
		const { submissions } = await res.json();
		expect(submissions).toHaveLength(1);

		// Decrypt with project private key and verify
		const decrypted = await decryptWithProjectKey(
			submissions[0].encryptedPayload,
			submissions[0].encryptedKeyProject,
			projectPrivateKey!
		);
		expect(decrypted).toEqual(payload);
	});

	test('MODERATOR sees submissions from multiple submitters', async ({ request }) => {
		// Set up first submitter (creates project)
		const { keys: sub1Keys, projectId, projectPublicKey, projectPrivateKey } = await setupAndAuthSubmitter(request);
		await postSubmission(request, projectPublicKey, sub1Keys.encryptionPublicKey, sub1Keys.signing.privateKey, projectId, { n: '1' });

		// Set up second submitter on same project
		const { keys: sub2Keys } = await setupAndAuthSubmitter(request, projectId, projectPublicKey);
		await postSubmission(request, projectPublicKey, sub2Keys.encryptionPublicKey, sub2Keys.signing.privateKey, projectId, { n: '2' });

		// Seed MODERATOR member + re-auth as MODERATOR
		const obsKeys = await generateUserKeys();
		const encryptedProjectPrivateKey = await buildEncryptedProjectPrivateKey(projectPrivateKey!, obsKeys.encryptionPublicKey);
		await request.post('/api/_test/seed', {
			data: { type: 'member', projectId, signingPublicKey: obsKeys.signingPublicKey, encryptionPublicKey: obsKeys.encryptionPublicKey, role: 'MODERATOR', encryptedProjectPrivateKey }
		});
		await reAuth(request, obsKeys.signingPublicKey, obsKeys.signing.privateKey);

		const res = await request.get(`/api/projects/${projectId}/submissions`);
		expect(res.status()).toBe(200);
		const { submissions } = await res.json();
		expect(submissions).toHaveLength(2);

		// All submissions should be decryptable with project key
		for (const s of submissions) {
			const d = await decryptWithProjectKey(s.encryptedPayload, s.encryptedKeyProject, projectPrivateKey!);
			expect(['1', '2']).toContain(d.n);
		}
	});

	test('unauthenticated request returns 401', async ({ request }) => {
		const res = await request.get('/api/projects/any-project/submissions');
		expect(res.status()).toBe(401);
		expect((await res.json()).message).toBeTruthy();
	});

	test('non-member returns 403', async ({ request }) => {
		await setupAndAuthSubmitter(request);

		// Create a project the user is NOT a member of
		const otherProjRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Other project', publicKey: 'pk' }
		});
		const { projectId: otherProjectId } = await otherProjRes.json();

		const res = await request.get(`/api/projects/${otherProjectId}/submissions`);
		expect(res.status()).toBe(403);
		expect((await res.json()).message).toBeTruthy();
	});
});
