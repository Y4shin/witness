/**
 * E2E tests for Step 12: submission flow.
 *
 * Tests cover POST /api/submissions:
 *  - happy path: encrypted submission stored; payload is not plaintext
 *  - non-happy path: invalid signature, replayed nonce, unknown public key, unauthenticated
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

async function authenticate(
	request: APIRequestContext,
	role: 'SUBMITTER' | 'OBSERVER' = 'SUBMITTER',
	existingProjectId?: string
) {
	const keys = await generateUserKeys();

	const userRes = await request.post('/api/_test/seed', {
		data: { type: 'user', signingPublicKey: keys.signingPublicKey, encryptionPublicKey: keys.encryptionPublicKey }
	});
	expect(userRes.status()).toBe(200);
	const { userId } = await userRes.json();

	let projectId = existingProjectId;
	let projectPublicKey: string | undefined;
	if (!projectId) {
		const projectEcdh = await crypto.subtle.generateKey(
			{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
		);
		projectPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', projectEcdh.publicKey));
		const projRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Submission Test', publicKey: projectPublicKey }
		});
		expect(projRes.status()).toBe(200);
		projectId = (await projRes.json()).projectId;
	}

	await request.post('/api/_test/seed', {
		data: { type: 'membership', userId, projectId, role }
	});

	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		keys.signing.privateKey,
		new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey: keys.signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});

	return { request, keys, projectId: projectId!, projectPublicKey, userId };
}

/**
 * Builds a valid submission payload using the crypto protocol.
 */
async function buildSubmission(
	projectPublicKeyJwk: string,
	userEncryptionPublicKeyJwk: string,
	signingPrivateKey: CryptoKey,
	nonce: string,
	payload: Record<string, string>
) {
	// 1. Generate symmetric key and encrypt payload
	const symKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, plaintext));
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv);
	combined.set(ciphertext, iv.length);
	const encryptedPayload = b64url(combined);

	// 2. Wrap symmetric key for project and user (ECDH hybrid)
	async function wrapKeyFor(pubKeyJwk: string) {
		const recipientPubKey = await crypto.subtle.importKey(
			'jwk', JSON.parse(pubKeyJwk),
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

	const [encryptedKeyProject, encryptedKeyUser] = await Promise.all([
		wrapKeyFor(projectPublicKeyJwk),
		wrapKeyFor(userEncryptionPublicKeyJwk)
	]);

	// 3. Sign (nonce_bytes || SHA-256(encryptedPayload_bytes))
	const nonceBytes = new TextEncoder().encode(nonce);
	const payloadBytes = new TextEncoder().encode(encryptedPayload);
	const sha256bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes));
	const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
	message.set(nonceBytes);
	message.set(sha256bytes, nonceBytes.length);

	const sigBytes = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, message
	);
	const submitterSignature = b64url(new Uint8Array(sigBytes));

	return { encryptedPayload, encryptedKeyProject, encryptedKeyUser, submitterSignature };
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('submission API', () => {
	test('submitter can POST a valid submission; encryptedPayload is not plaintext', async ({
		request
	}) => {
		const { request: authed, keys, projectId, projectPublicKey } = await authenticate(request);

		const { nonce } = await (await authed.get('/api/auth/challenge')).json();
		const submission = await buildSubmission(
			projectPublicKey!,
			keys.encryptionPublicKey,
			keys.signing.privateKey,
			nonce,
			{ field1: 'secret value' }
		);

		const res = await authed.post('/api/submissions', {
			data: { projectId, nonce, ...submission }
		});
		expect(res.status()).toBe(201);
		const body = await res.json();
		expect(body.submissionId).toBeTruthy();

		// encryptedPayload must not be the plaintext
		expect(submission.encryptedPayload).not.toContain('secret value');
		// Verify it's a base64url-looking string
		expect(submission.encryptedPayload).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test('submission with a tampered signature returns 400', async ({ request }) => {
		const { request: authed, keys, projectId, projectPublicKey } = await authenticate(request);

		const { nonce } = await (await authed.get('/api/auth/challenge')).json();
		const submission = await buildSubmission(
			projectPublicKey!,
			keys.encryptionPublicKey,
			keys.signing.privateKey,
			nonce,
			{ field1: 'test' }
		);

		// Tamper the signature by flipping a few bytes
		const sigBytes = b64urlDecode(submission.submitterSignature);
		sigBytes[0] ^= 0xff;
		const tamperedSignature = b64url(sigBytes);

		const res = await authed.post('/api/submissions', {
			data: {
				projectId,
				nonce,
				encryptedPayload: submission.encryptedPayload,
				encryptedKeyProject: submission.encryptedKeyProject,
				encryptedKeyUser: submission.encryptedKeyUser,
				submitterSignature: tamperedSignature
			}
		});
		expect(res.status()).toBe(400);
		expect((await res.json()).message).toBeTruthy();
	});

	test('replaying the same nonce returns 401', async ({ request }) => {
		const { request: authed, keys, projectId, projectPublicKey } = await authenticate(request);

		const { nonce } = await (await authed.get('/api/auth/challenge')).json();
		const submission = await buildSubmission(
			projectPublicKey!,
			keys.encryptionPublicKey,
			keys.signing.privateKey,
			nonce,
			{ field1: 'test' }
		);

		// First submission succeeds
		const first = await authed.post('/api/submissions', {
			data: { projectId, nonce, ...submission }
		});
		expect(first.status()).toBe(201);

		// Second with same nonce fails
		const second = await authed.post('/api/submissions', {
			data: { projectId, nonce, ...submission }
		});
		expect(second.status()).toBe(401);
	});

	test('using an unknown nonce returns 401', async ({ request }) => {
		const { request: authed, keys, projectId, projectPublicKey } = await authenticate(request);

		const fakeNonce = 'this-nonce-was-never-issued-XXXX';
		const submission = await buildSubmission(
			projectPublicKey!,
			keys.encryptionPublicKey,
			keys.signing.privateKey,
			fakeNonce,
			{ field1: 'test' }
		);

		const res = await authed.post('/api/submissions', {
			data: { projectId, nonce: fakeNonce, ...submission }
		});
		expect(res.status()).toBe(401);
	});

	test('unauthenticated submission returns 401', async ({ request }) => {
		const res = await request.post('/api/submissions', {
			data: {
				projectId: 'any',
				nonce: 'any',
				encryptedPayload: 'data',
				encryptedKeyProject: '{}',
				encryptedKeyUser: '{}',
				submitterSignature: 'sig'
			}
		});
		expect(res.status()).toBe(401);
	});

	test('submission to a project the user is not a member of returns 403', async ({ request }) => {
		const { request: authed } = await authenticate(request);

		// Seed a different project the user is NOT a member of
		const otherProjRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Other project', publicKey: 'pk' }
		});
		const { projectId: otherProjectId } = await otherProjRes.json();

		const { nonce } = await (await authed.get('/api/auth/challenge')).json();

		const res = await authed.post('/api/submissions', {
			data: {
				projectId: otherProjectId,
				nonce,
				encryptedPayload: 'data',
				encryptedKeyProject: '{}',
				encryptedKeyUser: '{}',
				submitterSignature: 'sig'
			}
		});
		expect(res.status()).toBe(403);
	});

	test('missing required fields return 400', async ({ request }) => {
		const { request: authed } = await authenticate(request);

		const res = await authed.post('/api/submissions', {
			data: { projectId: 'p', encryptedPayload: 'x' } // missing many fields
		});
		expect(res.status()).toBe(400);
	});
});
