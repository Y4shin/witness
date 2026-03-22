/**
 * Offline file cache using the CacheStorage API.
 *
 * Files are stored as encrypted bytes (the raw server response) so
 * E2E encryption is preserved. The service worker serves cached files
 * when the device is offline.
 *
 * The cache name is intentionally NOT versioned — file content is
 * immutable (identified by submissionId + fileId), so entries survive
 * service worker updates.
 */

export const FILES_CACHE = 'files-data';

/**
 * Stores a file response in the cache.
 * If `maxCacheMb > 0`, evicts the oldest entries until the total
 * size fits within the limit before adding the new entry.
 */
export async function cacheFileResponse(
	url: string,
	response: Response,
	maxCacheMb: number
): Promise<void> {
	if (!('caches' in window)) return;
	const cache = await caches.open(FILES_CACHE);

	if (maxCacheMb > 0) {
		await evictToFit(cache, maxCacheMb, response.headers.get('content-length'));
	}

	await cache.put(url, response);
}

/**
 * Returns the total size of the file cache in MB (best-effort estimate).
 */
export async function getCachedFileSizeMb(): Promise<number> {
	if (!('caches' in window)) return 0;
	if (!('storage' in navigator && 'estimate' in navigator.storage)) {
		// Fallback: sum Content-Length headers
		return sumCacheContentLength();
	}
	// Use Storage Quota API for a fast estimate
	// (not perfectly file-cache-only, but close enough for display)
	return sumCacheContentLength();
}

async function sumCacheContentLength(): Promise<number> {
	try {
		const cache = await caches.open(FILES_CACHE);
		const keys = await cache.keys();
		let totalBytes = 0;
		for (const req of keys) {
			const res = await cache.match(req);
			if (!res) continue;
			const cl = res.headers.get('content-length');
			if (cl) {
				totalBytes += parseInt(cl, 10);
			} else {
				// Clone and consume to measure size
				const buf = await res.clone().arrayBuffer();
				totalBytes += buf.byteLength;
			}
		}
		return totalBytes / (1024 * 1024);
	} catch {
		return 0;
	}
}

async function evictToFit(
	cache: Cache,
	maxMb: number,
	incomingContentLength: string | null
): Promise<void> {
	const incomingBytes = incomingContentLength ? parseInt(incomingContentLength, 10) : 0;
	const maxBytes = maxMb * 1024 * 1024;

	const keys = await cache.keys();
	let totalBytes = 0;
	const entries: { req: Request; bytes: number }[] = [];

	for (const req of keys) {
		const res = await cache.match(req);
		if (!res) continue;
		const cl = res.headers.get('content-length');
		const bytes = cl ? parseInt(cl, 10) : 0;
		totalBytes += bytes;
		entries.push({ req, bytes });
	}

	// Evict oldest entries (keys are ordered by insertion) until we have room
	let i = 0;
	while (totalBytes + incomingBytes > maxBytes && i < entries.length) {
		await cache.delete(entries[i].req);
		totalBytes -= entries[i].bytes;
		i++;
	}
}

/**
 * Deletes all entries from the file cache.
 */
export async function clearFileCache(): Promise<void> {
	if (!('caches' in window)) return;
	await caches.delete(FILES_CACHE);
}
