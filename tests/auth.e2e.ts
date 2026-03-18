import { test, expect } from '@playwright/test';

// ── crypto helpers (use Node.js Web Crypto — no $lib imports needed) ─────────

async function generateUserKeys() {
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
	return { signing, signingPublicKey, encryptionPublicKey };
}

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		privateKey,
		new TextEncoder().encode(nonce)
	);
	return b64url(new Uint8Array(sig));
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('auth API', () => {
	// ── GET /api/auth/challenge ────────────────────────────────────────────

	test('challenge endpoint returns a nonce', async ({ request }) => {
		const res = await request.get('/api/auth/challenge');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(typeof body.nonce).toBe('string');
		expect(body.nonce.length).toBeGreaterThan(0);
	});

	test('each challenge request returns a unique nonce', async ({ request }) => {
		const r1 = await request.get('/api/auth/challenge');
		const r2 = await request.get('/api/auth/challenge');
		const n1 = (await r1.json()).nonce;
		const n2 = (await r2.json()).nonce;
		expect(n1).not.toBe(n2);
	});

	// ── POST /api/auth/verify — non-happy path ─────────────────────────────

	test('verify returns 400 for invalid JSON', async ({ request }) => {
		const res = await request.post('/api/auth/verify', {
			headers: { 'Content-Type': 'application/json' },
			data: 'not json at all {'
		});
		expect(res.status()).toBe(400);
	});

	test('verify returns 400 when required fields are missing', async ({ request }) => {
		const res = await request.post('/api/auth/verify', {
			data: { signingPublicKey: 'some-key' } // missing nonce and signature
		});
		expect(res.status()).toBe(400);
	});

	test('verify returns 401 for an unknown nonce', async ({ request }) => {
		const { signing, signingPublicKey } = await generateUserKeys();
		const fakeNonce = 'no-such-nonce-was-ever-issued';
		const signature = await signNonce(signing.privateKey, fakeNonce);

		const res = await request.post('/api/auth/verify', {
			data: { signingPublicKey, nonce: fakeNonce, signature }
		});
		expect(res.status()).toBe(401);
	});

	// ── POST /api/auth/verify — happy path + replay prevention ────────────

	test('full auth flow: challenge → sign → verify → session cookie', async ({ request }) => {
		const { signing, signingPublicKey, encryptionPublicKey } = await generateUserKeys();

		// Seed a user with our known keys
		const seedRes = await request.post('/api/_test/seed', {
			data: { type: 'user', signingPublicKey, encryptionPublicKey }
		});
		expect(seedRes.status()).toBe(200);
		const { userId } = await seedRes.json();

		// Get a challenge
		const challengeRes = await request.get('/api/auth/challenge');
		const { nonce } = await challengeRes.json();

		// Sign and verify
		const signature = await signNonce(signing.privateKey, nonce);
		const verifyRes = await request.post('/api/auth/verify', {
			data: { signingPublicKey, nonce, signature }
		});

		expect(verifyRes.status()).toBe(200);
		expect((await verifyRes.json()).ok).toBe(true);

		// Cookie should be set
		const cookies = verifyRes.headers()['set-cookie'];
		expect(cookies).toContain('session=');
		expect(cookies).toContain('HttpOnly');

		// Confirm the session resolves to the correct user
		// (hooks.server.ts sets locals.user; we can check a protected endpoint later)
		expect(userId).toBeTruthy();
	});

	test('second use of the same nonce is rejected (replay prevention)', async ({ request }) => {
		const { signing, signingPublicKey, encryptionPublicKey } = await generateUserKeys();

		await request.post('/api/_test/seed', { data: { type: 'user', signingPublicKey, encryptionPublicKey } });

		const { nonce } = await (await request.get('/api/auth/challenge')).json();
		const signature = await signNonce(signing.privateKey, nonce);
		const body = { signingPublicKey, nonce, signature };

		const first = await request.post('/api/auth/verify', { data: body });
		expect(first.status()).toBe(200);

		const second = await request.post('/api/auth/verify', { data: body });
		expect(second.status()).toBe(401);
	});

	test('verify returns 401 for a wrong signature', async ({ request }) => {
		const { signing, signingPublicKey, encryptionPublicKey } = await generateUserKeys();
		await request.post('/api/_test/seed', { data: { type: 'user', signingPublicKey, encryptionPublicKey } });

		const { nonce } = await (await request.get('/api/auth/challenge')).json();
		// Sign a different message
		const signature = await signNonce(signing.privateKey, 'not the nonce');

		const res = await request.post('/api/auth/verify', {
			data: { signingPublicKey, nonce, signature }
		});
		expect(res.status()).toBe(401);
	});

	test('verify returns 401 when signed with a different private key', async ({ request }) => {
		const { signingPublicKey, encryptionPublicKey } = await generateUserKeys();
		await request.post('/api/_test/seed', { data: { type: 'user', signingPublicKey, encryptionPublicKey } });

		const otherKeys = await generateUserKeys();
		const { nonce } = await (await request.get('/api/auth/challenge')).json();
		const signature = await signNonce(otherKeys.signing.privateKey, nonce);

		const res = await request.post('/api/auth/verify', {
			data: { signingPublicKey, nonce, signature }
		});
		expect(res.status()).toBe(401);
	});

	// ── POST /api/auth/logout ─────────────────────────────────────────────

	test('logout returns 200 even when not logged in', async ({ request }) => {
		const res = await request.post('/api/auth/logout');
		expect(res.status()).toBe(200);
	});

	test('logout clears the session cookie', async ({ page }) => {
		const { signing, signingPublicKey, encryptionPublicKey } = await generateUserKeys();

		// Seed + authenticate via page.request (shares the browser cookie jar)
		await page.request.post('/api/_test/seed', { data: { type: 'user', signingPublicKey, encryptionPublicKey } });
		const { nonce } = await (await page.request.get('/api/auth/challenge')).json();
		const signature = await signNonce(signing.privateKey, nonce);
		const verifyRes = await page.request.post('/api/auth/verify', {
			data: { signingPublicKey, nonce, signature }
		});
		expect(verifyRes.status()).toBe(200);

		// Now logout
		const logoutRes = await page.request.post('/api/auth/logout');
		expect(logoutRes.status()).toBe(200);

		// The set-cookie header should clear the session cookie (max-age=0 or expires in past)
		const setCookie = logoutRes.headers()['set-cookie'] ?? '';
		expect(setCookie).toMatch(/session=;|session=$/);
	});
});
