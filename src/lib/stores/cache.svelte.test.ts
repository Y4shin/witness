/**
 * Unit tests for IndexedDB cold storage (cache.ts).
 * Runs in a browser-like environment via vitest-browser-svelte / happy-dom.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openCacheDb, initCacheKey, writeCacheEntry, readCacheEntry } from './cache';

// ── helpers ─────────────────────────────────────────────────────────────────

async function generateEncryptionKeyPair() {
	return crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('IndexedDB cold storage', () => {
	it('write then read recovers the original value', async () => {
		const pair = await generateEncryptionKeyPair();
		const db = await openCacheDb();
		const encKey = await initCacheKey(pair.privateKey);

		const value = { submissions: [{ id: 'abc', fields: { url: 'https://example.com' } }] };
		await writeCacheEntry(db, encKey, 'test:roundtrip', value);

		const result = await readCacheEntry<typeof value>(db, encKey, 'test:roundtrip');
		expect(result).toEqual(value);
	});

	it('returns null for a missing key', async () => {
		const pair = await generateEncryptionKeyPair();
		const db = await openCacheDb();
		const encKey = await initCacheKey(pair.privateKey);

		const result = await readCacheEntry(db, encKey, 'test:does-not-exist-' + Date.now());
		expect(result).toBeNull();
	});

	it('same private key produces the same cache encryption key (deterministic)', async () => {
		const pair = await generateEncryptionKeyPair();
		const db = await openCacheDb();

		const encKey1 = await initCacheKey(pair.privateKey);
		const encKey2 = await initCacheKey(pair.privateKey);

		const value = { hello: 'world' };
		await writeCacheEntry(db, encKey1, 'test:deterministic', value);

		// Re-derive key and read back — should still work
		const result = await readCacheEntry<typeof value>(db, encKey2, 'test:deterministic');
		expect(result).toEqual(value);
	});

	it('different private keys cannot decrypt each other\'s entries', async () => {
		const pair1 = await generateEncryptionKeyPair();
		const pair2 = await generateEncryptionKeyPair();
		const db = await openCacheDb();

		const encKey1 = await initCacheKey(pair1.privateKey);
		const encKey2 = await initCacheKey(pair2.privateKey);

		await writeCacheEntry(db, encKey1, 'test:cross-key', { secret: 'user1' });

		// Reading with a different key should throw (AES-GCM auth tag mismatch)
		await expect(
			readCacheEntry(db, encKey2, 'test:cross-key')
		).rejects.toThrow();
	});

	it('overwrites existing entry with same key', async () => {
		const pair = await generateEncryptionKeyPair();
		const db = await openCacheDb();
		const encKey = await initCacheKey(pair.privateKey);

		await writeCacheEntry(db, encKey, 'test:overwrite', { version: 1 });
		await writeCacheEntry(db, encKey, 'test:overwrite', { version: 2 });

		const result = await readCacheEntry<{ version: number }>(db, encKey, 'test:overwrite');
		expect(result?.version).toBe(2);
	});
});
