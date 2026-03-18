import { describe, it, expect } from 'vitest';
import { encode, decode } from './encoding';
import {
	generateUserKeyBundle,
	generateProjectKeyPair,
	exportUserKeyBundleJwk,
	importUserKeyBundleJwk,
	exportPublicKeyJwk,
	importEcdhPublicKey,
	importEcdsaPublicKey,
	jwkToString,
	stringToJwk
} from './keys';
import {
	generateSymmetricKey,
	exportRawKey,
	importRawKey,
	encryptSymmetric,
	decryptSymmetric
} from './symmetric';
import { encryptSymmetricKeyFor, decryptSymmetricKey } from './asymmetric';
import { sign, verify, signString, verifyString } from './signing';
import { deriveKeyFromPassphrase, deriveIndexedDbKey } from './kdf';

// ── encoding ─────────────────────────────────────────────────────────────────

describe('encoding', () => {
	it('round-trips arbitrary bytes', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(64));
		expect(decode(encode(bytes))).toEqual(bytes);
	});

	it('produces url-safe characters only', () => {
		for (let i = 0; i < 50; i++) {
			const bytes = crypto.getRandomValues(new Uint8Array(33)); // non-multiple of 3 → padding needed
			const b64 = encode(bytes);
			expect(b64).not.toMatch(/[+/=]/);
		}
	});

	it('round-trips empty bytes', () => {
		expect(decode(encode(new Uint8Array(0)))).toEqual(new Uint8Array(0));
	});

	it('decode throws on invalid base64', () => {
		expect(() => decode('!@#$')).toThrow();
	});
});

// ── keys ─────────────────────────────────────────────────────────────────────

describe('keys', () => {
	it('generateUserKeyBundle produces two distinct keypairs', async () => {
		const bundle = await generateUserKeyBundle();
		expect(bundle.signing.publicKey.algorithm.name).toBe('ECDSA');
		expect(bundle.encryption.publicKey.algorithm.name).toBe('ECDH');
	});

	it('signing keys cannot be used for ECDH derivation', async () => {
		const bundle = await generateUserKeyBundle();
		await expect(
			crypto.subtle.deriveBits(
				{ name: 'ECDH', public: bundle.signing.publicKey },
				bundle.signing.privateKey,
				256
			)
		).rejects.toThrow();
	});

	it('encryption keys cannot be used for signing', async () => {
		const bundle = await generateUserKeyBundle();
		await expect(
			crypto.subtle.sign(
				{ name: 'ECDSA', hash: 'SHA-256' },
				bundle.encryption.privateKey,
				new Uint8Array(8)
			)
		).rejects.toThrow();
	});

	it('round-trips UserKeyBundle through JWK export/import', async () => {
		const original = await generateUserKeyBundle();
		const jwk = await exportUserKeyBundleJwk(original);
		const restored = await importUserKeyBundleJwk(jwk);

		// Verify restored signing key works
		const data = new TextEncoder().encode('hello');
		const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, restored.signing.privateKey, data);
		const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, restored.signing.publicKey, sig, data);
		expect(ok).toBe(true);
	});

	it('generateProjectKeyPair produces an ECDH keypair', async () => {
		const kp = await generateProjectKeyPair();
		expect(kp.publicKey.algorithm.name).toBe('ECDH');
		expect(kp.privateKey.algorithm.name).toBe('ECDH');
	});

	it('jwkToString / stringToJwk round-trips', async () => {
		const bundle = await generateUserKeyBundle();
		const jwk = await exportPublicKeyJwk(bundle.signing.publicKey);
		const s = jwkToString(jwk);
		expect(typeof s).toBe('string');
		const parsed = stringToJwk(s);
		expect(parsed.kty).toBe('EC');
	});

	it('importEcdhPublicKey produces a key that cannot be used for signing', async () => {
		const bundle = await generateUserKeyBundle();
		const ecdsaJwk = await exportPublicKeyJwk(bundle.signing.publicKey);
		// Web Crypto allows the import (same curve bytes); but the resulting key has ECDH algorithm
		const imported = await importEcdhPublicKey(ecdsaJwk);
		expect(imported.algorithm.name).toBe('ECDH');
		// Cannot verify a signature with an ECDH key
		await expect(
			crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, new Uint8Array(64), new Uint8Array(8))
		).rejects.toThrow();
	});

	it('importEcdsaPublicKey rejects an ECDH public key JWK (key_ops mismatch)', async () => {
		const bundle = await generateUserKeyBundle();
		// ECDH public key is exported with empty key_ops; cannot import as ECDSA verify key
		const ecdhJwk = await exportPublicKeyJwk(bundle.encryption.publicKey);
		await expect(importEcdsaPublicKey(ecdhJwk)).rejects.toThrow();
	});
});

// ── symmetric ─────────────────────────────────────────────────────────────────

describe('symmetric', () => {
	it('encrypt / decrypt round-trips plaintext', async () => {
		const key = await generateSymmetricKey();
		const plaintext = new TextEncoder().encode('secret message');
		const ciphertext = await encryptSymmetric(key, plaintext);
		const decrypted = await decryptSymmetric(key, ciphertext);
		expect(decrypted).toEqual(plaintext);
	});

	it('each encrypt call produces a different ciphertext', async () => {
		const key = await generateSymmetricKey();
		const plaintext = new TextEncoder().encode('hello');
		const c1 = await encryptSymmetric(key, plaintext);
		const c2 = await encryptSymmetric(key, plaintext);
		expect(c1).not.toBe(c2);
	});

	it('decryption fails with wrong key', async () => {
		const key1 = await generateSymmetricKey();
		const key2 = await generateSymmetricKey();
		const ciphertext = await encryptSymmetric(key1, new TextEncoder().encode('data'));
		await expect(decryptSymmetric(key2, ciphertext)).rejects.toThrow();
	});

	it('decryption fails with tampered ciphertext', async () => {
		const key = await generateSymmetricKey();
		const ciphertext = await encryptSymmetric(key, new TextEncoder().encode('data'));
		const tampered = ciphertext.slice(0, -2) + 'AA';
		await expect(decryptSymmetric(key, tampered)).rejects.toThrow();
	});

	it('raw key export / import round-trips', async () => {
		const key = await generateSymmetricKey();
		const raw = await exportRawKey(key);
		const restored = await importRawKey(raw);
		const plaintext = new TextEncoder().encode('raw round trip');
		const ct = await encryptSymmetric(key, plaintext);
		const decrypted = await decryptSymmetric(restored, ct);
		expect(decrypted).toEqual(plaintext);
	});

	it('encrypts and decrypts empty plaintext', async () => {
		const key = await generateSymmetricKey();
		const ct = await encryptSymmetric(key, new Uint8Array(0));
		const decrypted = await decryptSymmetric(key, ct);
		expect(decrypted).toEqual(new Uint8Array(0));
	});
});

// ── asymmetric ────────────────────────────────────────────────────────────────

describe('asymmetric (ECDH hybrid key wrap)', () => {
	it('wraps and unwraps a symmetric key for a recipient', async () => {
		const recipient = await generateUserKeyBundle();
		const symKey = await generateSymmetricKey();

		const encryptedKey = await encryptSymmetricKeyFor(symKey, recipient.encryption.publicKey);
		const recovered = await decryptSymmetricKey(encryptedKey, recipient.encryption.privateKey);

		// Verify recovered key encrypts/decrypts correctly
		const plaintext = new TextEncoder().encode('hybrid test');
		const ct = await encryptSymmetric(symKey, plaintext);
		const decrypted = await decryptSymmetric(recovered, ct);
		expect(decrypted).toEqual(plaintext);
	});

	it('each wrap of the same key produces a different ciphertext', async () => {
		const recipient = await generateUserKeyBundle();
		const symKey = await generateSymmetricKey();
		const e1 = await encryptSymmetricKeyFor(symKey, recipient.encryption.publicKey);
		const e2 = await encryptSymmetricKeyFor(symKey, recipient.encryption.publicKey);
		expect(e1.wrappedKey).not.toBe(e2.wrappedKey);
	});

	it('unwrap fails with wrong private key', async () => {
		const alice = await generateUserKeyBundle();
		const bob = await generateUserKeyBundle();
		const symKey = await generateSymmetricKey();

		const encryptedForAlice = await encryptSymmetricKeyFor(symKey, alice.encryption.publicKey);
		await expect(decryptSymmetricKey(encryptedForAlice, bob.encryption.privateKey)).rejects.toThrow();
	});

	it('unwrap fails with tampered wrappedKey', async () => {
		const recipient = await generateUserKeyBundle();
		const symKey = await generateSymmetricKey();
		const encryptedKey = await encryptSymmetricKeyFor(symKey, recipient.encryption.publicKey);
		const tampered = { ...encryptedKey, wrappedKey: encryptedKey.wrappedKey.slice(0, -2) + 'AA' };
		await expect(decryptSymmetricKey(tampered, recipient.encryption.privateKey)).rejects.toThrow();
	});

	it('wraps for a project keypair (not just user keypair)', async () => {
		const project = await generateProjectKeyPair();
		const symKey = await generateSymmetricKey();
		const encrypted = await encryptSymmetricKeyFor(symKey, project.publicKey);
		const recovered = await decryptSymmetricKey(encrypted, project.privateKey);

		const plaintext = new TextEncoder().encode('project wrap test');
		const ct = await encryptSymmetric(symKey, plaintext);
		const decrypted = await decryptSymmetric(recovered, ct);
		expect(decrypted).toEqual(plaintext);
	});
});

// ── signing ───────────────────────────────────────────────────────────────────

describe('signing', () => {
	it('sign / verify round-trips', async () => {
		const bundle = await generateUserKeyBundle();
		const data = new TextEncoder().encode('sign me');
		const sig = await sign(bundle.signing.privateKey, data);
		expect(await verify(bundle.signing.publicKey, sig, data)).toBe(true);
	});

	it('signString / verifyString round-trips', async () => {
		const bundle = await generateUserKeyBundle();
		const sig = await signString(bundle.signing.privateKey, 'hello world');
		expect(await verifyString(bundle.signing.publicKey, sig, 'hello world')).toBe(true);
	});

	it('verify returns false for a different message', async () => {
		const bundle = await generateUserKeyBundle();
		const sig = await signString(bundle.signing.privateKey, 'original');
		expect(await verifyString(bundle.signing.publicKey, sig, 'modified')).toBe(false);
	});

	it('verify returns false with wrong public key', async () => {
		const alice = await generateUserKeyBundle();
		const bob = await generateUserKeyBundle();
		const sig = await signString(alice.signing.privateKey, 'hello');
		expect(await verifyString(bob.signing.publicKey, sig, 'hello')).toBe(false);
	});

	it('verify returns false for a tampered signature', async () => {
		const bundle = await generateUserKeyBundle();
		const data = new TextEncoder().encode('data');
		const sig = await sign(bundle.signing.privateKey, data);
		const tampered = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
		expect(await verify(bundle.signing.publicKey, tampered, data)).toBe(false);
	});

	it('each sign call produces a different signature (ECDSA is probabilistic)', async () => {
		const bundle = await generateUserKeyBundle();
		const data = new TextEncoder().encode('same data');
		const s1 = await sign(bundle.signing.privateKey, data);
		const s2 = await sign(bundle.signing.privateKey, data);
		// ECDSA uses a random nonce, so signatures differ
		expect(s1).not.toBe(s2);
	});
});

// ── kdf ───────────────────────────────────────────────────────────────────────

describe('kdf', () => {
	it('deriveKeyFromPassphrase produces a usable AES-GCM key', async () => {
		const { key } = await deriveKeyFromPassphrase('correct horse battery staple');
		expect(key.algorithm.name).toBe('AES-GCM');
		// Use it for encryption to confirm
		const ct = await encryptSymmetric(key, new TextEncoder().encode('kdf test'));
		const decrypted = await decryptSymmetric(key, ct);
		expect(decrypted).toEqual(new TextEncoder().encode('kdf test'));
	});

	it('deriveKeyFromPassphrase with same salt is deterministic', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const passphrase = 'deterministic passphrase';
		const { key: k1 } = await deriveKeyFromPassphrase(passphrase, { salt });
		const { key: k2 } = await deriveKeyFromPassphrase(passphrase, { salt });

		// Both keys should decrypt the same ciphertext
		const plaintext = new TextEncoder().encode('deterministic');
		const ct = await encryptSymmetric(k1, plaintext);
		const decrypted = await decryptSymmetric(k2, ct);
		expect(decrypted).toEqual(plaintext);
	});

	it('deriveKeyFromPassphrase with different salts produces different keys', async () => {
		const passphrase = 'same passphrase';
		const { key: k1 } = await deriveKeyFromPassphrase(passphrase);
		const { key: k2 } = await deriveKeyFromPassphrase(passphrase);

		// k1 and k2 have random distinct salts so they should differ
		const ct = await encryptSymmetric(k1, new TextEncoder().encode('test'));
		await expect(decryptSymmetric(k2, ct)).rejects.toThrow();
	});

	it('deriveKeyFromPassphrase returns the salt', async () => {
		const { saltB64 } = await deriveKeyFromPassphrase('pass');
		expect(typeof saltB64).toBe('string');
		expect(saltB64.length).toBeGreaterThan(0);
		// Decodable
		const salt = decode(saltB64);
		expect(salt.byteLength).toBe(16);
	});

	it('deriveIndexedDbKey produces a usable AES-GCM key', async () => {
		const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32));
		const key = await deriveIndexedDbKey(privateKeyBytes);
		expect(key.algorithm.name).toBe('AES-GCM');
	});

	it('deriveIndexedDbKey is deterministic for the same input', async () => {
		const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32));
		const k1 = await deriveIndexedDbKey(privateKeyBytes);
		const k2 = await deriveIndexedDbKey(privateKeyBytes);

		const plaintext = new TextEncoder().encode('idb test');
		const ct = await encryptSymmetric(k1, plaintext);
		const decrypted = await decryptSymmetric(k2, ct);
		expect(decrypted).toEqual(plaintext);
	});

	it('deriveIndexedDbKey produces different keys for different private key bytes', async () => {
		const b1 = crypto.getRandomValues(new Uint8Array(32));
		const b2 = crypto.getRandomValues(new Uint8Array(32));
		const k1 = await deriveIndexedDbKey(b1);
		const k2 = await deriveIndexedDbKey(b2);

		const ct = await encryptSymmetric(k1, new TextEncoder().encode('data'));
		await expect(decryptSymmetric(k2, ct)).rejects.toThrow();
	});
});
