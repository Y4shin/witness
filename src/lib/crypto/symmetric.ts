/**
 * AES-GCM symmetric encryption.
 * Each call to encrypt generates a fresh 96-bit IV.
 * The output format is: IV (12 bytes) || ciphertext+tag.
 */
import { encode, decode } from './encoding';

export async function generateSymmetricKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/**
 * Encrypts plaintext bytes with AES-GCM.
 * Returns a base64url string: base64url(iv || ciphertext+tag)
 */
export async function encryptSymmetric(key: CryptoKey, plaintext: Uint8Array): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
	);
	const combined = new Uint8Array(iv.length + ciphertext.length);
	combined.set(iv, 0);
	combined.set(ciphertext, iv.length);
	return encode(combined);
}

/**
 * Decrypts a base64url-encoded AES-GCM ciphertext (iv || ciphertext+tag).
 */
export async function decryptSymmetric(key: CryptoKey, encoded: string): Promise<Uint8Array> {
	const combined = decode(encoded);
	const iv = combined.slice(0, 12);
	const ciphertext = combined.slice(12);
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
}
