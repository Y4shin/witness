/**
 * Unit tests for the cross-device key bundle encrypt/decrypt roundtrip (Step 18).
 */
import { describe, it, expect } from 'vitest';
import { deriveKeyFromPassphrase, encryptSymmetric, decryptSymmetric, decode } from '$lib/crypto';

describe('cross-device key bundle crypto', () => {
	it('encrypt then decrypt with same passphrase recovers original bundle', async () => {
		const bundle = { signingPublicKey: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' } };
		const plaintext = new TextEncoder().encode(JSON.stringify(bundle));

		const { key, saltB64 } = await deriveKeyFromPassphrase('correct-horse-battery');
		const encrypted = await encryptSymmetric(key, plaintext);

		// Re-derive with same passphrase + stored salt
		const saltBytes = decode(saltB64);
		const { key: key2 } = await deriveKeyFromPassphrase('correct-horse-battery', { salt: saltBytes });
		const decrypted = await decryptSymmetric(key2, encrypted);

		expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual(bundle);
	});

	it('decrypt with wrong passphrase throws', async () => {
		const plaintext = new TextEncoder().encode(JSON.stringify({ secret: 'data' }));
		const { key, saltB64 } = await deriveKeyFromPassphrase('correct-passphrase');
		const encrypted = await encryptSymmetric(key, plaintext);

		const saltBytes = decode(saltB64);
		const { key: wrongKey } = await deriveKeyFromPassphrase('wrong-passphrase', { salt: saltBytes });

		await expect(decryptSymmetric(wrongKey, encrypted)).rejects.toThrow();
	});

	it('different salts produce different keys from same passphrase', async () => {
		const { key: key1, saltB64: salt1 } = await deriveKeyFromPassphrase('same-passphrase');
		const { key: key2, saltB64: salt2 } = await deriveKeyFromPassphrase('same-passphrase');

		// Salts should differ (random generation)
		expect(salt1).not.toBe(salt2);

		// Encrypting with key1 cannot be decrypted with key2
		const plaintext = new TextEncoder().encode('test');
		const encrypted = await encryptSymmetric(key1, plaintext);
		await expect(decryptSymmetric(key2, encrypted)).rejects.toThrow();
	});
});
