/**
 * Unit tests for Step 19: export/import key bundle crypto.
 * Validates the JSON format and passphrase-based roundtrip.
 */
import { describe, it, expect } from 'vitest';
import { deriveKeyFromPassphrase, encryptSymmetric, decryptSymmetric, decode } from '$lib/crypto';

const SAMPLE_BUNDLE = {
	signingPublicKey: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' },
	signingPrivateKey: { kty: 'EC', crv: 'P-256', d: 'priv1' },
	encryptionPublicKey: { kty: 'EC', crv: 'P-256', x: 'ghi', y: 'jkl' },
	encryptionPrivateKey: { kty: 'EC', crv: 'P-256', d: 'priv2' }
};

async function buildExportFile(bundle: object, passphrase: string) {
	const { key, saltB64 } = await deriveKeyFromPassphrase(passphrase);
	const encrypted = await encryptSymmetric(key, new TextEncoder().encode(JSON.stringify(bundle)));
	return JSON.stringify({ v: 1, salt: saltB64, encrypted });
}

async function importFile(fileJson: string, passphrase: string) {
	const { v, salt, encrypted } = JSON.parse(fileJson) as { v: number; salt: string; encrypted: string };
	if (!v || !salt || !encrypted) throw new Error('Invalid file: missing fields');
	const saltBytes = decode(salt);
	const { key } = await deriveKeyFromPassphrase(passphrase, { salt: saltBytes });
	const plaintext = await decryptSymmetric(key, encrypted);
	return JSON.parse(new TextDecoder().decode(plaintext));
}

describe('export/import key backup', () => {
	it('exported JSON contains v, salt, encrypted fields', async () => {
		const json = await buildExportFile(SAMPLE_BUNDLE, 'test-passphrase-123');
		const parsed = JSON.parse(json);
		expect(parsed.v).toBe(1);
		expect(typeof parsed.salt).toBe('string');
		expect(typeof parsed.encrypted).toBe('string');
	});

	it('importing with correct passphrase restores the original bundle', async () => {
		const json = await buildExportFile(SAMPLE_BUNDLE, 'my-secret-pass');
		const restored = await importFile(json, 'my-secret-pass');
		expect(restored).toEqual(SAMPLE_BUNDLE);
	});

	it('importing with wrong passphrase throws', async () => {
		const json = await buildExportFile(SAMPLE_BUNDLE, 'correct-pass');
		await expect(importFile(json, 'wrong-pass')).rejects.toThrow();
	});

	it('importing a file with missing fields throws a clear validation error', async () => {
		const badJson = JSON.stringify({ v: 1, salt: 'abc' }); // missing encrypted
		await expect(importFile(badJson, 'any')).rejects.toThrow(/missing fields/i);
	});

	it('importing a corrupted JSON string throws a parse error', async () => {
		await expect(importFile('not-valid-json', 'any')).rejects.toThrow();
	});
});
