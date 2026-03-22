/**
 * IndexedDB cold storage with AES-GCM encryption at rest.
 *
 * The encryption key is derived deterministically from the user's ECDH
 * private key bytes via HKDF, so it can be re-derived on every page load
 * without storing the derived key itself.
 *
 * Usage:
 *   const db = await openCacheDb();
 *   const encKey = await initCacheKey(userBundle.encryption.privateKey);
 *   await writeCacheEntry(db, encKey, 'submissions:proj-id', myData);
 *   const data = await readCacheEntry(db, encKey, 'submissions:proj-id');
 */
import { deriveIndexedDbKey, exportPrivateKeyPkcs8, encryptSymmetric, decryptSymmetric } from '$lib/crypto';

const DB_NAME = 'rt-cache';
const STORE_NAME = 'entries';
export const PENDING_STORE = 'pending-submissions';
const DB_VERSION = 2;

export async function openCacheDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = (e.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'key' });
			}
			if (!db.objectStoreNames.contains(PENDING_STORE)) {
				db.createObjectStore(PENDING_STORE, { keyPath: 'id' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Derives the IndexedDB encryption key from the user's ECDH private key.
 * The same private key always produces the same encryption key.
 */
export async function initCacheKey(encryptionPrivateKey: CryptoKey): Promise<CryptoKey> {
	const pkcs8 = await exportPrivateKeyPkcs8(encryptionPrivateKey);
	return deriveIndexedDbKey(pkcs8);
}

/**
 * Encrypts `value` and writes it to IndexedDB under `key`.
 * Overwrites any existing entry with the same key.
 */
export async function writeCacheEntry<T>(
	db: IDBDatabase,
	encKey: CryptoKey,
	key: string,
	value: T
): Promise<void> {
	const plaintext = new TextEncoder().encode(JSON.stringify(value));
	const encrypted = await encryptSymmetric(encKey, plaintext);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		const store = tx.objectStore(STORE_NAME);
		const req = store.put({ key, encrypted });
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

/**
 * Reads and decrypts a cached entry. Returns `null` if the key does not exist.
 * Throws if decryption fails (wrong key / corrupted data).
 */
export async function readCacheEntry<T>(
	db: IDBDatabase,
	encKey: CryptoKey,
	key: string
): Promise<T | null> {
	const record = await new Promise<{ key: string; encrypted: string } | undefined>(
		(resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const store = tx.objectStore(STORE_NAME);
			const req = store.get(key);
			req.onsuccess = () => resolve(req.result as { key: string; encrypted: string } | undefined);
			req.onerror = () => reject(req.error);
		}
	);
	if (!record) return null;
	const plaintext = await decryptSymmetric(encKey, record.encrypted);
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
