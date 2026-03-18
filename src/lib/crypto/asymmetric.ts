/**
 * ECDH hybrid encryption.
 *
 * To encrypt a symmetric key for a recipient's ECDH public key:
 *   1. Generate an ephemeral ECDH keypair.
 *   2. Derive a shared AES-GCM wrapping key via ECDH + HKDF.
 *   3. Wrap (encrypt) the symmetric key bytes with AES-GCM.
 *   4. Output: ephemeral public key JWK + wrapped key ciphertext.
 *
 * The recipient uses their private key + the ephemeral public key to
 * re-derive the same shared wrapping key and unwrap.
 */
import { encode, decode } from './encoding';
import { exportPublicKeyJwk, importEcdhPublicKey } from './keys';

export interface EncryptedKey {
	/** Ephemeral ECDH public key as compact JSON */
	ephemeralPublicKey: JsonWebKey;
	/** base64url(iv || wrappedKey+tag) */
	wrappedKey: string;
}

async function deriveWrappingKey(
	privateKey: CryptoKey,
	publicKey: CryptoKey,
	salt: Uint8Array
): Promise<CryptoKey> {
	const shared = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: publicKey },
		privateKey,
		256
	);
	const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt,
			info: new TextEncoder().encode('reporting-tool-key-wrap')
		},
		hkdfKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['wrapKey', 'unwrapKey']
	);
}

/**
 * Encrypts (wraps) a symmetric key for the given ECDH recipient public key.
 */
export async function encryptSymmetricKeyFor(
	symmetricKey: CryptoKey,
	recipientPublicKey: CryptoKey
): Promise<EncryptedKey> {
	const ephemeral = await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);

	const ephemeralPublicKey = await exportPublicKeyJwk(ephemeral.publicKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const salt = crypto.getRandomValues(new Uint8Array(32));

	const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, recipientPublicKey, salt);

	const wrapped = new Uint8Array(
		await crypto.subtle.wrapKey('raw', symmetricKey, wrappingKey, { name: 'AES-GCM', iv })
	);

	// Encode as: salt (32) || iv (12) || wrapped
	const combined = new Uint8Array(salt.length + iv.length + wrapped.length);
	combined.set(salt, 0);
	combined.set(iv, salt.length);
	combined.set(wrapped, salt.length + iv.length);

	return { ephemeralPublicKey, wrappedKey: encode(combined) };
}

/**
 * Decrypts (unwraps) a symmetric key using the recipient's ECDH private key.
 */
export async function decryptSymmetricKey(
	encryptedKey: EncryptedKey,
	recipientPrivateKey: CryptoKey
): Promise<CryptoKey> {
	const ephemeralPublicKey = await importEcdhPublicKey(encryptedKey.ephemeralPublicKey);
	const combined = decode(encryptedKey.wrappedKey);

	const salt = combined.slice(0, 32);
	const iv = combined.slice(32, 44);
	const wrapped = combined.slice(44);

	const wrappingKey = await deriveWrappingKey(recipientPrivateKey, ephemeralPublicKey, salt);

	return crypto.subtle.unwrapKey(
		'raw',
		wrapped,
		wrappingKey,
		{ name: 'AES-GCM', iv },
		{ name: 'AES-GCM' },
		true,
		['encrypt', 'decrypt']
	);
}
