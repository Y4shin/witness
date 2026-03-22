/**
 * E2E tests for offline submission queue, sync on reconnect, and offline browsing.
 *
 * Tests cover:
 *  - Submitting while offline queues the payload in IndexedDB and shows a warning
 *  - Layout auto-syncs queued submissions when the page is loaded while online
 *  - Layout auto-syncs queued submissions when the `online` event fires
 *  - SyncStatusBar is visible and shows a disabled sync button while offline
 *  - Submissions page serves cached data with an offline banner when offline
 */
import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';

test.setTimeout(60000);

// ── crypto helpers ───────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

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
	return {
		signing,
		encryption,
		signingPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey)),
		encryptionPublicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', encryption.publicKey))
	};
}

async function wrapKeyFor(symKey: CryptoKey, recipientPublicKeyJwk: string): Promise<string> {
	const recipientPubKey = await crypto.subtle.importKey(
		'jwk',
		JSON.parse(recipientPublicKeyJwk),
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		[]
	);
	const ephemeral = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
	const ephemeralPublicKey = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
	const salt = crypto.getRandomValues(new Uint8Array(32));
	const wrapIv = crypto.getRandomValues(new Uint8Array(12));
	const shared = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: recipientPubKey },
		ephemeral.privateKey,
		256
	);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	const wrappingKey = await crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt,
			info: new TextEncoder().encode('reporting-tool-key-wrap')
		},
		hkdfKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['wrapKey']
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

// ── shared setup helpers ─────────────────────────────────────────────────────

/**
 * Seeds a project + submitter member via the API, authenticates via `request`
 * (which shares cookie storage with `page`), and returns the key bundle.
 */
async function seedAndAuthSubmitter(request: APIRequestContext, projectName: string) {
	const keys = await generateUserKeys();

	const projectEcdh = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
	const projectPublicKey = JSON.stringify(
		await crypto.subtle.exportKey('jwk', projectEcdh.publicKey)
	);

	const projRes = await request.post('/api/_test/seed', {
		data: { type: 'project', name: projectName, publicKey: projectPublicKey }
	});
	expect(projRes.status()).toBe(200);
	const { projectId } = await projRes.json();

	await request.post('/api/_test/seed', {
		data: {
			type: 'member',
			projectId,
			signingPublicKey: keys.signingPublicKey,
			encryptionPublicKey: keys.encryptionPublicKey,
			role: 'SUBMITTER'
		}
	});

	const { nonce } = await (await request.get('/api/auth/challenge')).json();
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		keys.signing.privateKey,
		new TextEncoder().encode(nonce)
	);
	await request.post('/api/auth/verify', {
		data: {
			signingPublicKey: keys.signingPublicKey,
			nonce,
			signature: b64url(new Uint8Array(sig))
		}
	});

	const bundle = {
		signingPublicKey: JSON.parse(keys.signingPublicKey),
		signingPrivateKey: await crypto.subtle.exportKey('jwk', keys.signing.privateKey),
		encryptionPublicKey: JSON.parse(keys.encryptionPublicKey),
		encryptionPrivateKey: await crypto.subtle.exportKey('jwk', keys.encryption.privateKey)
	};

	return { keys, bundle, projectId };
}

/**
 * Install the service worker by loading the root page first.
 * This ensures subsequent navigations are intercepted and nav-cached by the SW.
 */
async function installServiceWorker(page: Page) {
	await page.goto('/');
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/**
 * Navigate to the project submit page, inject localStorage keys, reload so
 * the page picks them up, and wait until the form is ready.
 *
 * When `withSwCache` is true, first installs the SW and navigates to the page
 * while the SW is active so the URL is stored in the nav-cache.  This is required
 * for tests that reload the page while offline.
 */
async function goToSubmitPage(
	page: Page,
	projectId: string,
	bundle: object,
	opts: { projectName?: string; withSwCache?: boolean } = {}
) {
	const { projectName = 'Test Project', withSwCache = false } = opts;
	const memberships = { [projectId]: { bundle, projectName, role: 'SUBMITTER' } };
	const url = `/projects/${projectId}/submit`;

	if (withSwCache) {
		// Install the SW, then navigate to the submit page so it is nav-cached
		await installServiceWorker(page);
		await page.goto(url);
	} else {
		await page.goto(url);
	}

	await page.evaluate(
		(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
		memberships
	);
	await page.reload();
	// Wait for onMount to finish importing keys and set mode='form'
	await expect(page.getByTestId('submit-btn')).toBeVisible({ timeout: 15000 });

	// If SW caching is required, ensure the nav-cache write has committed before
	// the caller goes offline and tries to reload from cache.
	if (withSwCache) {
		await waitForNavCache(page, url);
	}
}

/**
 * Wait until the SW has written `url` into the nav-cache.
 * Must be called after a SW-controlled navigation to `url` so that the
 * fire-and-forget `cache.put` in the service worker has time to complete
 * before we go offline and try to load the page from cache.
 */
async function waitForNavCache(page: Page, url: string, timeout = 10000): Promise<void> {
	await page.waitForFunction(
		async (relUrl: string) => {
			const cacheKeys = await caches.keys();
			const navCacheKey = cacheKeys.find((k: string) => k.startsWith('nav-cache-'));
			if (!navCacheKey) return false;
			const cache = await caches.open(navCacheKey);
			const fullUrl = new URL(relUrl, location.href).href;
			const match = await cache.match(fullUrl);
			return match !== null;
		},
		url,
		{ timeout }
	);
}

/** Read all records from the pending-submissions IDB store. */
async function getPendingSubmissions(page: Page): Promise<unknown[]> {
	return page.evaluate(async () => {
		return new Promise<unknown[]>((resolve, reject) => {
			const req = indexedDB.open('rt-cache');
			req.onerror = () => reject(req.error);
			req.onsuccess = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('pending-submissions')) {
					resolve([]);
					return;
				}
				const tx = db.transaction('pending-submissions', 'readonly');
				const store = tx.objectStore('pending-submissions');
				const all = store.getAll();
				all.onsuccess = () => resolve(all.result);
				all.onerror = () => reject(all.error);
			};
		});
	});
}

// ── offline queue tests ─────────────────────────────────────────────────────

test.describe('offline submission queue', () => {
	test('shows queued alert and stores entry in IDB when submitted offline', async ({
		page,
		request,
		context
	}) => {
		const { bundle, projectId } = await seedAndAuthSubmitter(request, 'Offline Queue Test');
		await goToSubmitPage(page, projectId, bundle);

		// Verify the submissions API is not called while offline
		let submissionPosted = false;
		await page.route('**/api/submissions', (route) => {
			if (route.request().method() === 'POST') submissionPosted = true;
			route.continue();
		});

		await context.setOffline(true);

		// Fill and submit the form
		await page.getByLabel('URL').fill('https://example.com/offline-test');
		await page.getByTestId('submit-btn').click();

		// The queued warning alert should appear
		await expect(
			page.getByRole('status').filter({ hasText: "You're offline" })
		).toBeVisible({ timeout: 10000 });

		// No POST to /api/submissions was attempted
		expect(submissionPosted).toBe(false);

		// One entry should be present in the pending-submissions IDB store
		const pending = await getPendingSubmissions(page);
		expect(pending).toHaveLength(1);
		expect((pending[0] as { projectId: string }).projectId).toBe(projectId);
	});

	test('auto-syncs queued submission when page reloads online', async ({
		page,
		request,
		context
	}) => {
		const { bundle, projectId } = await seedAndAuthSubmitter(request, 'Auto-sync Test');
		await goToSubmitPage(page, projectId, bundle);

		// Queue a submission offline
		await context.setOffline(true);
		await page.getByLabel('URL').fill('https://example.com/auto-sync');
		await page.getByTestId('submit-btn').click();
		await expect(
			page.getByRole('status').filter({ hasText: "You're offline" })
		).toBeVisible({ timeout: 10000 });

		// Come back online, set localStorage before reload (so layout can import signing key)
		await context.setOffline(false);
		const memberships = { [projectId]: { bundle, projectName: 'Auto-sync Test', role: 'SUBMITTER' } };
		await page.evaluate(
			(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
			memberships
		);

		// Reload — layout's onMount sees pendingCount=1, online=true → auto-syncs
		const syncResponse = page.waitForResponse(
			(res) =>
				res.url().includes('/api/submissions') &&
				res.request().method() === 'POST' &&
				res.status() === 201,
			{ timeout: 20000 }
		);
		await page.reload();
		await syncResponse;

		// Queue should now be empty
		const pending = await getPendingSubmissions(page);
		expect(pending).toHaveLength(0);
	});

	test('SyncStatusBar shows correct states and syncs on reconnect', async ({
		page,
		request,
		context
	}) => {
		const { bundle, projectId } = await seedAndAuthSubmitter(request, 'SyncStatusBar Test');
		await goToSubmitPage(page, projectId, bundle);

		// Step 1: Queue a submission while offline
		await context.setOffline(true);
		await page.getByLabel('URL').fill('https://example.com/sync-bar-test');
		await page.getByTestId('submit-btn').click();
		await expect(
			page.getByRole('status').filter({ hasText: "You're offline" })
		).toBeVisible({ timeout: 10000 });

		// Step 2: Come back online; block challenge so auto-sync fails, keeping pendingCount > 0
		await context.setOffline(false);
		const memberships = {
			[projectId]: { bundle, projectName: 'SyncStatusBar Test', role: 'SUBMITTER' }
		};
		await page.evaluate(
			(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
			memberships
		);
		// Abort challenge requests so sync fails immediately
		await page.route('**/api/auth/challenge', (route) => route.abort('failed'));

		// Reload online — layout mounts, tries auto-sync, challenge aborted → sync fails fast
		await page.reload();
		await page.waitForLoadState('networkidle');

		// SyncStatusBar shows "Sync now" (enabled, online, pendingCount=1, not syncing)
		const syncNowBtn = page.getByRole('button', { name: 'Sync now' });
		await expect(syncNowBtn).toBeVisible({ timeout: 10000 });
		await expect(syncNowBtn).toBeEnabled();

		// Step 3: Go offline — SyncStatusBar switches to "Reconnect to sync" (disabled)
		await context.setOffline(true);
		const reconnectBtn = page.getByRole('button', { name: 'Reconnect to sync' });
		await expect(reconnectBtn).toBeVisible({ timeout: 5000 });
		await expect(reconnectBtn).toBeDisabled();

		// Step 4: Unblock challenge, come back online — handleOnline fires → sync succeeds
		await page.unroute('**/api/auth/challenge');
		const syncResponse = page.waitForResponse(
			(res) =>
				res.url().includes('/api/submissions') &&
				res.request().method() === 'POST' &&
				res.status() === 201,
			{ timeout: 20000 }
		);
		await context.setOffline(false);
		await syncResponse;

		// SyncStatusBar should disappear (pendingCount=0)
		await expect(reconnectBtn).not.toBeVisible({ timeout: 10000 });
	});
});

// ── offline browsing tests ──────────────────────────────────────────────────

test.describe('offline browsing', () => {
	test('shows cached submissions from IDB with offline banner when API fails', async ({
		page,
		request
	}) => {
		const { bundle, projectId } = await seedAndAuthSubmitter(request, 'Offline Browse Test');

		// Post a submission via the API so there is something to view
		{
			const symKey = await crypto.subtle.generateKey(
				{ name: 'AES-GCM', length: 256 },
				true,
				['encrypt', 'decrypt']
			);
			const plaintext = new TextEncoder().encode(
				JSON.stringify({ url: 'https://example.com/cached-page' })
			);
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const ciphertext = new Uint8Array(
				await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symKey, plaintext)
			);
			const combined = new Uint8Array(iv.length + ciphertext.length);
			combined.set(iv);
			combined.set(ciphertext, iv.length);
			const encryptedPayload = b64url(combined);

			const encryptedKeyUser = await wrapKeyFor(
				symKey,
				JSON.stringify(bundle.encryptionPublicKey)
			);
			const throwawayEcdh = await crypto.subtle.generateKey(
				{ name: 'ECDH', namedCurve: 'P-256' },
				true,
				['deriveKey', 'deriveBits']
			);
			const encryptedKeyProject = await wrapKeyFor(
				symKey,
				JSON.stringify(await crypto.subtle.exportKey('jwk', throwawayEcdh.publicKey))
			);

			const { nonce: subNonce } = await (await request.get('/api/auth/challenge')).json();
			const nonceBytes = new TextEncoder().encode(subNonce);
			const payloadBytes = new TextEncoder().encode(encryptedPayload);
			const sha256bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes));
			const msg = new Uint8Array(nonceBytes.length + sha256bytes.length);
			msg.set(nonceBytes);
			msg.set(sha256bytes, nonceBytes.length);
			const signingKey = await crypto.subtle.importKey(
				'jwk',
				bundle.signingPrivateKey as JsonWebKey,
				{ name: 'ECDSA', namedCurve: 'P-256' },
				false,
				['sign']
			);
			const sigBytes = await crypto.subtle.sign(
				{ name: 'ECDSA', hash: 'SHA-256' },
				signingKey,
				msg
			);
			const subRes = await request.post('/api/submissions', {
				data: {
					projectId,
					nonce: subNonce,
					type: 'WEBPAGE',
					encryptedPayload,
					encryptedKeyProject,
					encryptedKeyUser,
					submitterSignature: b64url(new Uint8Array(sigBytes))
				}
			});
			expect(subRes.status()).toBe(201);
		}

		const memberships = {
			[projectId]: { bundle, projectName: 'Offline Browse Test', role: 'SUBMITTER' }
		};
		const submissionsUrl = `/projects/${projectId}/submissions`;

		// First load: navigate to submissions page online, inject keys, reload so onMount
		// decrypts submissions and writes them to IDB.
		await page.goto(submissionsUrl);
		await page.evaluate(
			(data) => localStorage.setItem('rt:memberships', JSON.stringify(data)),
			memberships
		);
		await page.reload();
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 20000 });
		// Allow the fire-and-forget writeCacheEntry to complete
		await page.waitForTimeout(500);

		// Second load: simulate offline by mocking navigator.onLine=false (via addInitScript)
		// and aborting the submissions API. The page HTML is still served by the dev server
		// (we are not network-offline), but the app behaves as if offline:
		//   - navigator.onLine = false  → isOffline flag set in the catch handler
		//   - API fails                 → catches fall through to IDB cache (mode='cached')
		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, 'onLine', {
				get: () => false,
				configurable: true
			});
		});
		await page.route(`**/api/projects/${projectId}/submissions`, (route) =>
			route.abort('failed')
		);

		await page.reload();

		// Cached submission should still be visible (served from IDB)
		await expect(page.getByTestId('submission-card')).toBeVisible({ timeout: 15000 });

		// Offline banner should be shown
		await expect(
			page.getByRole('status').filter({ hasText: "You're offline" })
		).toBeVisible({ timeout: 5000 });
	});

	test('previously visited page loads from nav-cache when offline', async ({
		page,
		context
	}) => {
		// Nav-cache requires a stable SW version (production build).
		// In dev mode, SvelteKit's HMR may reinstall the SW between cache write and
		// the offline reload, causing the activate handler to evict the nav-cache.
		// Run this test with: npx playwright test --config playwright.pwa.config.ts
		test.skip(
			!process.env.TEST_PROD_BUILD,
			'Requires production build — run with playwright.pwa.config.ts'
		);

		// First visit: install the SW (this navigation itself is NOT nav-cached
		// because the SW wasn't yet controlling when the response arrived)
		await page.goto('/');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

		// Second visit: SW is now controlling, so it intercepts and nav-caches the response
		await page.reload();
		await page.waitForLoadState('networkidle');
		// Wait for the fire-and-forget cache.put in the SW to actually commit
		await waitForNavCache(page, '/');

		// Go offline and reload — SW should serve the cached HTML, not the /offline fallback
		await context.setOffline(true);
		await page.reload();

		await expect(page.getByRole('heading', { name: "You're offline" })).not.toBeVisible({
			timeout: 5000
		});
		const title = await page.title();
		expect(title).toContain('Witness');
	});
});
