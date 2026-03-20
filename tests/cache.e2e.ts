/**
 * E2E tests for Step 16: IndexedDB cold storage.
 *
 * Verifies that after loading submissions once, a page reload with all API
 * routes blocked still shows the cached (decrypted) submission data.
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

// ── crypto helpers ──────────────────────────────────────────────────────────

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

async function setupSubmitter(request: APIRequestContext) {
	const keys = await generateUserKeys();

	const projectEcdh = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
	);
	const projectPublicKey = JSON.stringify(await crypto.subtle.exportKey('jwk', projectEcdh.publicKey));
	const projRes = await request.post('/api/_test/seed', {
		data: { type: 'project', name: 'Cache Test Project', publicKey: projectPublicKey }
	});
	expect(projRes.status()).toBe(200);
	const projectId = (await projRes.json()).projectId as string;

	await request.post('/api/_test/seed', {
		data: { type: 'member', projectId, signingPublicKey: keys.signingPublicKey, encryptionPublicKey: keys.encryptionPublicKey, role: 'SUBMITTER' }
	});

	// Authenticate
	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' }, keys.signing.privateKey, new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: { signingPublicKey: keys.signingPublicKey, nonce, signature: b64url(new Uint8Array(sig)) }
	});

	// Post a submission
	const symKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
	const plaintext = new TextEncoder().encode(JSON.stringify({ url: 'https://example.com/cached-page' }));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, plaintext));
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv); combined.set(ciphertext, iv.length);
	const encryptedPayload = b64url(combined);

	const [encryptedKeyProject, encryptedKeyUser] = await Promise.all([
		wrapKeyFor(symKey, projectPublicKey),
		wrapKeyFor(symKey, keys.encryptionPublicKey)
	]);

	const { nonce: subNonce } = await (await request.get('/api/auth/challenge')).json();
	const nonceBytes = new TextEncoder().encode(subNonce);
	const payloadBytes = new TextEncoder().encode(encryptedPayload);
	const sha256bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes));
	const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
	message.set(nonceBytes); message.set(sha256bytes, nonceBytes.length);
	const sigBytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.signing.privateKey, message);

	const subRes = await request.post('/api/submissions', {
		data: { projectId, nonce: subNonce, type: 'WEBPAGE', encryptedPayload, encryptedKeyProject, encryptedKeyUser, submitterSignature: b64url(new Uint8Array(sigBytes)) }
	});
	expect(subRes.status()).toBe(201);

	return { keys, projectId };
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('IndexedDB cold storage', () => {
	test('submissions are served from cache after API routes are blocked', async ({ page, request }) => {
		const { keys, projectId } = await setupSubmitter(request);

		// Store the member's key bundle in rt:memberships format
		const bundle = {
			signingPublicKey: JSON.parse(keys.signingPublicKey),
			signingPrivateKey: await crypto.subtle.exportKey('jwk', keys.signing.privateKey),
			encryptionPublicKey: JSON.parse(keys.encryptionPublicKey),
			encryptionPrivateKey: await crypto.subtle.exportKey('jwk', keys.encryption.privateKey)
		};
		const memberships = { [projectId]: { bundle, projectName: 'Cache Test Project', role: 'SUBMITTER' } };

		// Navigate to submissions page — this populates the cache
		await page.goto(`/projects/${projectId}/submissions`);
		await page.evaluate((data) => {
			localStorage.setItem('rt:memberships', JSON.stringify(data));
		}, memberships);

		// Reload so the page picks up the stored keys
		await page.reload();
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });

		// Now block all API requests to submissions endpoint
		await page.route('**/api/projects/**/submissions', (route) => route.abort());

		// Reload again — should still show cached submissions
		await page.reload();
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 10000 });
	});

	test('logout clears in-memory state but cold storage remains', async ({ page, request }) => {
		const { keys, projectId } = await setupSubmitter(request);

		const bundle = {
			signingPublicKey: JSON.parse(keys.signingPublicKey),
			signingPrivateKey: await crypto.subtle.exportKey('jwk', keys.signing.privateKey),
			encryptionPublicKey: JSON.parse(keys.encryptionPublicKey),
			encryptionPrivateKey: await crypto.subtle.exportKey('jwk', keys.encryption.privateKey)
		};
		const memberships = { [projectId]: { bundle, projectName: 'Cache Test Project', role: 'SUBMITTER' } };

		await page.goto(`/projects/${projectId}/submissions`);
		await page.evaluate((data) => {
			localStorage.setItem('rt:memberships', JSON.stringify(data));
		}, memberships);
		await page.reload();
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });

		// Simulate logout: clear localStorage (keys) but NOT IndexedDB
		await page.evaluate(() => localStorage.removeItem('rt:memberships'));

		// IndexedDB should still have the encrypted record
		const hasIdbRecord = await page.evaluate(async () => {
			return new Promise<boolean>((resolve) => {
				const req = indexedDB.open('rt-cache');
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains('entries')) { resolve(false); return; }
					const tx = db.transaction('entries', 'readonly');
					const store = tx.objectStore('entries');
					const countReq = store.count();
					countReq.onsuccess = () => resolve(countReq.result > 0);
					countReq.onerror = () => resolve(false);
				};
				req.onerror = () => resolve(false);
			});
		});
		expect(hasIdbRecord).toBe(true);
	});
});
