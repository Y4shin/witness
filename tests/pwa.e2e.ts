import { test, expect } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

/** Navigate to a page and wait until the service worker is installed and
 *  controlling the current document (thanks to skipWaiting + clients.claim). */
async function waitForServiceWorker(page: import('@playwright/test').Page, url: string) {
	await page.goto(url);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

// ── manifest ───────────────────────────────────────────────────────────────

test.describe('PWA manifest', () => {
	test('serves a valid web app manifest', async ({ request }) => {
		const res = await request.get('/manifest.json');
		expect(res.ok()).toBe(true);

		const manifest = await res.json();
		expect(manifest.name).toBe('Witness');
		expect(manifest.short_name).toBe('Witness');
		expect(manifest.display).toBe('standalone');
		expect(manifest.start_url).toBe('/');
		expect(Array.isArray(manifest.icons)).toBe(true);
		expect(manifest.icons.length).toBeGreaterThan(0);
	});

	test('icon file referenced in manifest is accessible', async ({ request }) => {
		const manifestRes = await request.get('/manifest.json');
		const manifest = await manifestRes.json();
		const iconSrc: string = manifest.icons[0].src;

		const iconRes = await request.get(iconSrc);
		expect(iconRes.ok()).toBe(true);
	});
});

// ── service worker ─────────────────────────────────────────────────────────

test.describe('PWA service worker', () => {
	test('registers and activates on first page load', async ({ page, context }) => {
		const swPromise = context.waitForEvent('serviceworker');
		await page.goto('/');
		const sw = await swPromise;

		expect(sw.url()).toContain('service-worker');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	});
});

// ── offline behaviour ──────────────────────────────────────────────────────

test.describe('PWA offline page', () => {
	test('shows English offline page when navigating offline', async ({ page, context }) => {
		await waitForServiceWorker(page, '/');

		await context.setOffline(true);
		await page.goto('/');

		await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
	});

	test('shows German offline page when navigating offline with German locale cookie', async ({
		page,
		context
	}) => {
		// Set the locale cookie BEFORE the SW installs so cache.add('/offline') fetches
		// the German version (locale is cookie-based, not URL-based on the server).
		await context.addCookies([
			{ name: 'PARAGLIDE_LOCALE', value: 'de', domain: 'localhost', path: '/' }
		]);
		await waitForServiceWorker(page, '/de/');

		await context.setOffline(true);
		await page.goto('/de/');

		await expect(page.getByRole('heading', { name: 'Keine Internetverbindung' })).toBeVisible();
	});

	test('offline page has a retry button', async ({ page, context }) => {
		await waitForServiceWorker(page, '/');

		await context.setOffline(true);
		await page.goto('/');

		await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
	});

	test('does not intercept API requests (they fail normally when offline)', async ({
		page,
		context
	}) => {
		await waitForServiceWorker(page, '/');

		await context.setOffline(true);

		// API requests should bypass the SW and fail with a network error
		const res = await page.request.fetch('/api/auth/challenge', { failOnStatusCode: false }).catch(() => null);
		// Either null (fetch threw) or a non-200 response — either way not the offline page HTML
		if (res !== null) {
			const body = await res.text();
			expect(body).not.toContain("You're offline");
		}
	});

	test('previously visited page is served from nav-cache when offline', async ({
		page,
		context
	}) => {
		// Nav-cache requires a stable SW version (production build).
		// In dev mode, SvelteKit's HMR may reinstall the SW between the cache write and
		// the offline reload, causing the activate handler to evict the nav-cache.
		// Run this test with: npx playwright test --config playwright.pwa.config.ts
		test.skip(
			!process.env.TEST_PROD_BUILD,
			'Requires production build — run with playwright.pwa.config.ts'
		);

		// First load: SW installs and takes control, but does NOT intercept this navigation
		// (the SW wasn't controlling when the request was made)
		await waitForServiceWorker(page, '/');

		// Second load: SW is controlling, so it intercepts, serves the response, and
		// fire-and-forgets a cache.put into nav-cache.
		await page.reload();
		await page.waitForLoadState('networkidle');

		// Wait for the fire-and-forget cache.put to commit before going offline
		await page.waitForFunction(async () => {
			const keys = await caches.keys();
			const navKey = keys.find((k: string) => k.startsWith('nav-cache-'));
			if (!navKey) return false;
			const cache = await caches.open(navKey);
			return (await cache.match(location.href)) !== null;
		}, undefined, { timeout: 10000 });

		// Go offline and reload — the SW should serve the cached HTML
		await context.setOffline(true);
		await page.reload();

		// The page should load from cache (not fall through to the offline page)
		await expect(page.getByRole('heading', { name: "You're offline" })).not.toBeVisible({
			timeout: 5000
		});
		// Some Witness app content should be present
		const title = await page.title();
		expect(title).toContain('Witness');
	});
});
