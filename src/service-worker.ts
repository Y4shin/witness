/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE = `offline-cache-${version}`;
const OFFLINE_PAGE = '/offline';

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_PAGE)));
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);
	if (url.pathname.startsWith('/api/')) return;

	event.respondWith(
		fetch(event.request).catch(() => caches.match(OFFLINE_PAGE).then((r) => r!))
	);
});
