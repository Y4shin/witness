/**
 * Key derivation functions.
 *
 * PBKDF2: passphrase → AES-GCM key (for cross-device key bundle transfer)
 * HKDF:   private key bytes → AES-GCM key (for IndexedDB cold storage encryption)
 */
import { encode } from './encoding';

export interface Pbkdf2Params {
	iterations?: number;
	salt?: Uint8Array;
}

export interface DerivedKeyResult {
	key: CryptoKey;
	/** base64url-encoded salt (must be stored alongside the ciphertext) */
	saltB64: string;
}

/**
 * Derives an AES-GCM-256 key from a passphrase using PBKDF2-SHA-256.
 * If no salt is provided a fresh 16-byte random salt is generated.
 */
export async function deriveKeyFromPassphrase(
	passphrase: string,
	{ iterations = 310_000, salt }: Pbkdf2Params = {}
): Promise<DerivedKeyResult> {
	const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		false,
		['deriveKey']
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			salt: actualSalt,
			iterations
		},
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
	return { key, saltB64: encode(actualSalt) };
}

/**
 * Derives a deterministic AES-GCM-256 key from raw ECDH private key bytes
 * using HKDF-SHA-256. Used to encrypt the key bundle stored in IndexedDB.
 *
 * The derived key is deterministic — the same private key always produces the
 * same IndexedDB encryption key — so re-derivation after page reload works
 * without storing the derived key itself.
 */
export async function deriveIndexedDbKey(privateKeyBytes: Uint8Array): Promise<CryptoKey> {
	const hkdfKey = await crypto.subtle.importKey('raw', privateKeyBytes, 'HKDF', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(32), // fixed zero salt — key itself is high entropy
			info: new TextEncoder().encode('witness-indexeddb')
		},
		hkdfKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}
