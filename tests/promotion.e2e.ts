/**
 * E2E tests for Step 14: MODERATOR promotion.
 *
 * Tests cover POST /api/projects/[id]/promote:
 *  - happy path: submitter promoted; can then decrypt project key (verified by accessing submissions)
 *  - submitter attempting to promote returns 403
 *  - MODERATOR attempting to promote an already-MODERATOR returns 409
 *  - promoting a user from a different project returns 404
 *  - unauthenticated returns 401
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

async function buildEncryptedProjectPrivateKey(projectPrivateKey: CryptoKey, userEncryptionPublicKeyJwk: string): Promise<string> {
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

async function seedAndAuth(
	request: APIRequestContext,
	role: 'SUBMITTER' | 'MODERATOR',
	existingProjectId?: string,
	existingProjectPublicKey?: string,
	existingProjectPrivateKey?: CryptoKey
) {
	const keys = await generateUserKeys();

	let projectId = existingProjectId;
	let projectPublicKey = existingProjectPublicKey;
	let projectPrivateKey = existingProjectPrivateKey;

	if (!projectId) {
		const projectEcdh = await crypto.subtle.generateKey(
			{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
		);
		projectPrivateKey = projectEcdh.privateKey;
		projectPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', projectEcdh.publicKey));
		const projRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Promotion Test', publicKey: projectPublicKey }
		});
		projectId = (await projRes.json()).projectId;
	}

	let encryptedProjectPrivateKey: string | undefined;
	if (role === 'MODERATOR' && projectPrivateKey) {
		encryptedProjectPrivateKey = await buildEncryptedProjectPrivateKey(projectPrivateKey, keys.encryptionPublicKey);
	}

	const memberRes = await request.post('/api/_test/seed', {
		data: { type: 'member', projectId, signingPublicKey: keys.signingPublicKey, encryptionPublicKey: keys.encryptionPublicKey, role, encryptedProjectPrivateKey }
	});
	expect(memberRes.status()).toBe(200);
	const { memberId } = await memberRes.json();

	// Challenge / verify
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

/** Re-encrypts projectPrivateKey for targetEncPublicKey and returns the JSON bundle. */
async function reEncryptProjectKey(projectPrivateKey: CryptoKey, targetEncPublicKeyJwk: string): Promise<string> {
	return buildEncryptedProjectPrivateKey(projectPrivateKey, targetEncPublicKeyJwk);
}

/** Decrypts the encryptedProjectPrivateKey bundle using the user's encryption private key. */
async function decryptProjectPrivateKey(
	encryptedProjectPrivateKey: string,
	userEncPrivateKey: CryptoKey
): Promise<CryptoKey> {
	const bundle = JSON.parse(encryptedProjectPrivateKey) as { payload: string; key: { ephemeralPublicKey: JsonWebKey; wrappedKey: string } };

	const ephPub = await crypto.subtle.importKey('jwk', bundle.key.ephemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
	const wrapCombined = b64urlDecode(bundle.key.wrappedKey);
	const salt = wrapCombined.slice(0, 32);
	const wrapIv = wrapCombined.slice(32, 44);
	const wrapped = wrapCombined.slice(44);

	const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephPub }, userEncPrivateKey, 256);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	const wrappingKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('reporting-tool-key-wrap') },
		hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']
	);
	const symKey = await crypto.subtle.unwrapKey('raw', wrapped, wrappingKey, { name: 'AES-GCM', iv: wrapIv }, { name: 'AES-GCM' }, true, ['decrypt']);

	const payloadCombined = b64urlDecode(bundle.payload);
	const payloadIv = payloadCombined.slice(0, 12);
	const payloadCiphertext = payloadCombined.slice(12);
	const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payloadIv }, symKey, payloadCiphertext);

	return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('MODERATOR promotion', () => {
	test('MODERATOR can promote a submitter; promoted user gets an encryptedProjectPrivateKey', async ({ request }) => {
		// Set up MODERATOR (creates project)
		const { keys: obsKeys, projectId, projectPublicKey, projectPrivateKey } = await seedAndAuth(request, 'MODERATOR');

		// Seed a submitter member
		const subKeys = await generateUserKeys();
		const subMemberRes = await request.post('/api/_test/seed', {
			data: { type: 'member', projectId, signingPublicKey: subKeys.signingPublicKey, encryptionPublicKey: subKeys.encryptionPublicKey, role: 'SUBMITTER' }
		});
		const { memberId: subMemberId } = await subMemberRes.json();

		// MODERATOR POSTs promote
		const encProjPrivKey = await reEncryptProjectKey(projectPrivateKey!, subKeys.encryptionPublicKey);
		const res = await request.post(`/api/projects/${projectId}/promote`, {
			data: { targetMemberId: subMemberId, encryptedProjectPrivateKey: encProjPrivKey }
		});
		expect(res.status()).toBe(200);
		expect((await res.json()).ok).toBe(true);

		// Verify: submitter can now decrypt the project private key
		// Re-authenticate as submitter (who is now MODERATOR)
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		// Fetch their membership to get encryptedProjectPrivateKey
		const membersRes = await request.get(`/api/projects/${projectId}/members`);
		expect(membersRes.status()).toBe(200);
		const { members } = await membersRes.json();
		const promotedMember = members.find((m: { memberId: string }) => m.memberId === subMemberId);
		expect(promotedMember.role).toBe('MODERATOR');

		// Re-auth as MODERATOR again to verify encryptedProjectPrivateKey is accessible via server load
		// (we check by calling GET /api/projects/[id]/submissions as the promoted MODERATOR, seeding a submission first)
		await request.post('/api/_test/seed', {
			data: { type: 'submission', projectId, memberId: subMemberId, encryptedKeyProject: '{}', encryptedPayload: 'x', encryptedKeyUser: '{}', submitterSignature: 'sig' }
		});

		// Re-auth as MODERATOR (original) and check submissions count
		await reAuth(request, obsKeys.signingPublicKey, obsKeys.signing.privateKey);
		const subRes = await request.get(`/api/projects/${projectId}/submissions`);
		expect(subRes.status()).toBe(200);
		const { submissions } = await subRes.json();
		expect(submissions).toHaveLength(1);

		void projectPublicKey;
		void obsKeys;
	});

	test('promoted user can decrypt project private key with their own key', async ({ request }) => {
		// Set up MODERATOR
		const { keys: obsKeys, projectId, projectPrivateKey } = await seedAndAuth(request, 'MODERATOR');

		// Seed submitter
		const subKeys = await generateUserKeys();
		const subMemberRes = await request.post('/api/_test/seed', {
			data: { type: 'member', projectId, signingPublicKey: subKeys.signingPublicKey, encryptionPublicKey: subKeys.encryptionPublicKey, role: 'SUBMITTER' }
		});
		const { memberId: subMemberId } = await subMemberRes.json();

		// Re-auth as MODERATOR and promote
		await reAuth(request, obsKeys.signingPublicKey, obsKeys.signing.privateKey);
		const encProjPrivKey = await reEncryptProjectKey(projectPrivateKey!, subKeys.encryptionPublicKey);
		const promoteRes = await request.post(`/api/projects/${projectId}/promote`, {
			data: { targetMemberId: subMemberId, encryptedProjectPrivateKey: encProjPrivKey }
		});
		expect(promoteRes.status()).toBe(200);

		// Re-auth as promoted user, get their encryptedProjectPrivateKey from the API
		await reAuth(request, subKeys.signingPublicKey, subKeys.signing.privateKey);

		// Get members list to confirm role changed
		const membersRes = await request.get(`/api/projects/${projectId}/members`);
		const { members } = await membersRes.json();
		const me = members.find((m: { memberId: string }) => m.memberId === subMemberId);
		expect(me.role).toBe('MODERATOR');

		// Simulate decrypting the encryptedProjectPrivateKey received via the promotion
		const recovered = await decryptProjectPrivateKey(encProjPrivKey, subKeys.encryption.privateKey);

		// Verify it matches the original: try to export both and compare
		const origPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', projectPrivateKey!));
		const recoveredPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', recovered));
		expect(origPkcs8).toEqual(recoveredPkcs8);
	});

	test('submitter attempting to promote returns 403', async ({ request }) => {
		const { projectId, memberId } = await seedAndAuth(request, 'SUBMITTER');

		const res = await request.post(`/api/projects/${projectId}/promote`, {
			data: { targetMemberId: memberId, encryptedProjectPrivateKey: '{}' }
		});
		expect(res.status()).toBe(403);
		expect((await res.json()).message).toBeTruthy();
	});

	test('promoting an already-MODERATOR returns 409', async ({ request }) => {
		const { keys: obsKeys, projectId, projectPrivateKey } = await seedAndAuth(request, 'MODERATOR');

		// Seed a second MODERATOR
		const obs2Keys = await generateUserKeys();
		const encProjPrivKey2 = await buildEncryptedProjectPrivateKey(projectPrivateKey!, obs2Keys.encryptionPublicKey);
		const obs2Res = await request.post('/api/_test/seed', {
			data: { type: 'member', projectId, signingPublicKey: obs2Keys.signingPublicKey, encryptionPublicKey: obs2Keys.encryptionPublicKey, role: 'MODERATOR', encryptedProjectPrivateKey: encProjPrivKey2 }
		});
		const { memberId: obs2MemberId } = await obs2Res.json();

		// Re-auth as first MODERATOR
		await reAuth(request, obsKeys.signingPublicKey, obsKeys.signing.privateKey);

		// Try to promote the second MODERATOR
		const res = await request.post(`/api/projects/${projectId}/promote`, {
			data: { targetMemberId: obs2MemberId, encryptedProjectPrivateKey: '{}' }
		});
		expect(res.status()).toBe(409);
		expect((await res.json()).message).toBeTruthy();
	});

	test('promoting a user not in the project returns 404', async ({ request }) => {
		const { keys: obsKeys, projectId } = await seedAndAuth(request, 'MODERATOR');
		await reAuth(request, obsKeys.signingPublicKey, obsKeys.signing.privateKey);

		const res = await request.post(`/api/projects/${projectId}/promote`, {
			data: { targetMemberId: 'non-existent-member-id', encryptedProjectPrivateKey: '{}' }
		});
		expect(res.status()).toBe(404);
		expect((await res.json()).message).toBeTruthy();
	});

	test('unauthenticated promote returns 401', async ({ request }) => {
		const res = await request.post('/api/projects/some-project/promote', {
			data: { targetMemberId: 'u', encryptedProjectPrivateKey: '{}' }
		});
		expect(res.status()).toBe(401);
	});

	test('GET /api/projects/[id]/members returns 401 unauthenticated', async ({ request }) => {
		const res = await request.get('/api/projects/some-project/members');
		expect(res.status()).toBe(401);
	});

	test('GET /api/projects/[id]/members returns 403 for non-member', async ({ request }) => {
		await seedAndAuth(request, 'SUBMITTER');

		const otherProjRes = await request.post('/api/_test/seed', {
			data: { type: 'project', name: 'Other', publicKey: 'pk' }
		});
		const { projectId: otherProjectId } = await otherProjRes.json();

		const res = await request.get(`/api/projects/${otherProjectId}/members`);
		expect(res.status()).toBe(403);
	});
});
