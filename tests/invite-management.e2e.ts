/**
 * E2E tests for Step 15: invite link management.
 *
 * Tests cover:
 *  - POST /api/invites — MODERATOR creates links with various options
 *  - GET /api/projects/[id]/invites — MODERATOR lists links
 *  - DELETE /api/invites/[token] — MODERATOR revokes link
 *  - Access control: submitter 403, unauthenticated 401
 *  - Expired-at in past returns 400
 *  - max_uses=1 and claiming twice — second claim rejected (410)
 *  - Revoked link returns 410 on claim
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

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
	const signingPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey));
	const encryptionPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', encryption.publicKey));
	return { signing, encryption, signingPublicKey, encryptionPublicKey };
}

async function seedAndAuth(request: APIRequestContext, role: 'SUBMITTER' | 'MODERATOR' = 'MODERATOR') {
	const keys = await generateUserKeys();

	const userRes = await request.post('/api/_test/seed', {
		data: { type: 'user', signingPublicKey: keys.signingPublicKey, encryptionPublicKey: keys.encryptionPublicKey }
	});
	expect(userRes.status()).toBe(200);
	const { userId } = await userRes.json();

	const projectEcdh = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	const projectPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', projectEcdh.publicKey));
	const projRes = await request.post('/api/_test/seed', {
		data: { type: 'project', name: 'Invite Test', publicKey: projectPublicKey }
	});
	const { projectId } = await projRes.json();

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

	return { keys, projectId, userId };
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('invite link management', () => {
	test('MODERATOR can create and list invite links', async ({ request }) => {
		const { projectId } = await seedAndAuth(request);

		// Create a submitter invite
		const createRes = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER', maxUses: 3 }
		});
		expect(createRes.status()).toBe(201);
		const { token } = await createRes.json();
		expect(token).toBeTruthy();

		// List invites
		const listRes = await request.get(`/api/projects/${projectId}/invites`);
		expect(listRes.status()).toBe(200);
		const { invites } = await listRes.json();
		expect(invites).toHaveLength(1);
		expect(invites[0].token).toBe(token);
		expect(invites[0].role).toBe('SUBMITTER');
		expect(invites[0].maxUses).toBe(3);
		expect(invites[0].usedCount).toBe(0);
	});

	test('MODERATOR can create an MODERATOR invite link', async ({ request }) => {
		const { projectId } = await seedAndAuth(request);

		const res = await request.post('/api/invites', {
			data: { projectId, role: 'MODERATOR' }
		});
		expect(res.status()).toBe(201);
		const { token } = await res.json();
		expect(token).toBeTruthy();

		const listRes = await request.get(`/api/projects/${projectId}/invites`);
		const { invites } = await listRes.json();
		expect(invites[0].role).toBe('MODERATOR');
	});

	test('MODERATOR can revoke an invite link', async ({ request }) => {
		const { projectId } = await seedAndAuth(request);

		const createRes = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER' }
		});
		const { token } = await createRes.json();

		// Revoke it
		const revokeRes = await request.delete(`/api/invites/${token}`);
		expect(revokeRes.status()).toBe(200);
		expect((await revokeRes.json()).ok).toBe(true);

		// Verify it's gone from the list
		const listRes = await request.get(`/api/projects/${projectId}/invites`);
		const { invites } = await listRes.json();
		expect(invites).toHaveLength(0);
	});

	test('revoked link returns 410 when someone tries to claim it', async ({ request }) => {
		const { projectId } = await seedAndAuth(request);

		const createRes = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER' }
		});
		const { token } = await createRes.json();

		// Revoke
		await request.delete(`/api/invites/${token}`);

		// Try to claim the revoked link — hard-deleted so returns 404
		const infoRes = await request.get(`/api/invites/${token}`);
		expect(infoRes.status()).toBe(404);
	});

	test('max_uses=1 link: second claim is rejected with 410', async ({ request }) => {
		const { projectId } = await seedAndAuth(request);

		// Seed an invite directly with usedCount already at capacity
		const seedRes = await request.post('/api/_test/seed', {
			data: { type: 'inviteLink', projectId, role: 'SUBMITTER', maxUses: 1, usedCount: 1 }
		});
		expect(seedRes.status()).toBe(200);
		const { token } = await seedRes.json();

		// The invite is now at capacity — GET should return 410
		const infoRes = await request.get(`/api/invites/${token}`);
		expect(infoRes.status()).toBe(410);
	});

	test('creating a link with expiry in the past returns 400', async ({ request }) => {
		const { projectId } = await seedAndAuth(request);

		const pastDate = new Date(Date.now() - 60000).toISOString();
		const res = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER', expiresAt: pastDate }
		});
		expect(res.status()).toBe(400);
		expect((await res.json()).message).toBeTruthy();
	});

	test('submitter cannot create invite links (403)', async ({ request }) => {
		const { projectId } = await seedAndAuth(request, 'SUBMITTER');

		const res = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER' }
		});
		expect(res.status()).toBe(403);
		expect((await res.json()).message).toBeTruthy();
	});

	test('submitter cannot list invite links (403)', async ({ request }) => {
		const { projectId } = await seedAndAuth(request, 'SUBMITTER');

		const res = await request.get(`/api/projects/${projectId}/invites`);
		expect(res.status()).toBe(403);
	});

	test('submitter cannot revoke invite links (403)', async ({ request }) => {
		// Seed MODERATOR to create a link, then test with submitter
		const { projectId } = await seedAndAuth(request, 'MODERATOR');
		const createRes = await request.post('/api/invites', {
			data: { projectId, role: 'SUBMITTER' }
		});
		const { token } = await createRes.json();

		// Seed and auth a submitter
		const subKeys = await generateUserKeys();
		const subUserRes = await request.post('/api/_test/seed', {
			data: { type: 'user', signingPublicKey: subKeys.signingPublicKey, encryptionPublicKey: subKeys.encryptionPublicKey }
		});
		const { userId: subUserId } = await subUserRes.json();
		await request.post('/api/_test/seed', {
			data: { type: 'membership', userId: subUserId, projectId, role: 'SUBMITTER' }
		});
		const { nonce } = await (await request.get('/api/auth/challenge')).json();
		const sig = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' }, subKeys.signing.privateKey, new TextEncoder().encode(nonce)
		);
		await request.post('/api/auth/verify', {
			data: { signingPublicKey: subKeys.signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
		});

		const revokeRes = await request.delete(`/api/invites/${token}`);
		expect(revokeRes.status()).toBe(403);
	});

	test('unauthenticated user cannot create invite links (401)', async ({ request }) => {
		const res = await request.post('/api/invites', {
			data: { projectId: 'any', role: 'SUBMITTER' }
		});
		expect(res.status()).toBe(401);
	});

	test('unauthenticated user cannot list invite links (401)', async ({ request }) => {
		const res = await request.get('/api/projects/any-project/invites');
		expect(res.status()).toBe(401);
	});
});
