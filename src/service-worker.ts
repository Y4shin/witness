/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const OFFLINE_CACHE = `offline-cache-${version}`;
const ASSETS_CACHE = `assets-cache-${version}`;
const NAV_CACHE = `nav-cache-${version}`;
const FILES_CACHE = 'files-data'; // not versioned — file content is immutable

const OFFLINE_PAGE = '/offline';
// Pre-cache SvelteKit build artifacts + static files alongside the offline page.
const PRECACHE_ASSETS = [...build, ...files];

async function notifyClient(
	clientId: string | undefined,
	type: 'online-navigation' | 'offline-navigation'
) {
	if (!clientId) return;
	const client = await self.clients.get(clientId);
	client?.postMessage({ type });
}

// ── Install ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
	event.waitUntil(
		Promise.all([
			caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_PAGE)),
			caches.open(ASSETS_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS))
		])
	);
	self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
	const validCaches = new Set([OFFLINE_CACHE, ASSETS_CACHE, NAV_CACHE, FILES_CACHE]);
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => !validCaches.has(k)).map((k) => caches.delete(k)))
			)
			.then(() => self.clients.claim())
	);
});

// ── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	// 1. Encrypted file downloads — cache-first (content is immutable)
	if (/^\/api\/submissions\/[^/]+\/files\/[^/]+$/.test(url.pathname)) {
		event.respondWith(
			caches.open(FILES_CACHE).then(async (cache) => {
				const cached = await cache.match(event.request);
				if (cached) return cached;
				return fetch(event.request);
			})
		);
		return;
	}

	// 2. All other API calls — pass through (no caching)
	if (url.pathname.startsWith('/api/')) return;

	// 3. Content-addressed immutable assets — cache-first
	if (url.pathname.startsWith('/_app/immutable/')) {
		event.respondWith(
			caches.open(ASSETS_CACHE).then(async (cache) => {
				const cached = await cache.match(event.request);
				if (cached) return cached;
				const fresh = await fetch(event.request);
				if (fresh.ok) cache.put(event.request, fresh.clone());
				return fresh;
			})
		);
		return;
	}

	// 4. Navigation requests (HTML) — network-first, stale-on-offline
	const isNavigation =
		event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html');

	if (isNavigation) {
		event.respondWith(
			fetch(event.request)
				.then((res) => {
					if (res.ok) {
						const clone = res.clone();
						// Use event.waitUntil so the SW isn't terminated before the write completes.
						event.waitUntil(
							Promise.all([
								caches.open(NAV_CACHE).then((cache) => cache.put(event.request.url, clone)),
								notifyClient(event.clientId, 'online-navigation')
							])
						);
					}
					return res;
				})
				.catch(async () => {
					// Open the cache explicitly — caches.match(url, { cacheName }) can miss in
					// some Chromium builds; cache.match(url) on an opened cache is reliable.
					const navCache = await caches.open(NAV_CACHE);
					const cached = await navCache.match(event.request.url);
					if (cached) {
						event.waitUntil(notifyClient(event.clientId, 'offline-navigation'));
						return cached;
					}
					const offlineCache = await caches.open(OFFLINE_CACHE);
					event.waitUntil(notifyClient(event.clientId, 'offline-navigation'));
					return (await offlineCache.match(OFFLINE_PAGE))!;
				})
		);
		return;
	}

	// 5. Other static resources — network-first with assets-cache fallback
	event.respondWith(
		fetch(event.request)
			.then((res) => {
				if (res.ok) {
					caches.open(ASSETS_CACHE).then((cache) => cache.put(event.request, res.clone()));
				}
				return res;
			})
			.catch(async () => {
				const cached = await caches.match(event.request, { cacheName: ASSETS_CACHE });
				return cached ?? fetch(event.request);
			})
	);
});
