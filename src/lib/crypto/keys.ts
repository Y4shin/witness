/**
 * Keypair generation and JWK serialization.
 *
 * Two keypairs per user:
 *   - signing:    ECDSA P-256  (sign/verify)
 *   - encryption: ECDH P-256   (hybrid encrypt/decrypt)
 *
 * Web Crypto enforces key-usage separation — you cannot use an ECDH key
 * for signing or vice versa.
 */

export interface UserKeyBundle {
	/** ECDSA P-256 keypair for signing submissions and invite links */
	signing: CryptoKeyPair;
	/** ECDH P-256 keypair for receiving encrypted symmetric keys */
	encryption: CryptoKeyPair;
}

/** JWK representations suitable for storage and transmission */
export interface UserKeyBundleJwk {
	signingPublicKey: JsonWebKey;
	signingPrivateKey: JsonWebKey;
	encryptionPublicKey: JsonWebKey;
	encryptionPrivateKey: JsonWebKey;
}

export async function generateUserKeyBundle(): Promise<UserKeyBundle> {
	const [signing, encryption] = await Promise.all([
		crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
		crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
			'deriveKey',
			'deriveBits'
		])
	]);
	return { signing, encryption };
}

export async function generateProjectKeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveKey',
		'deriveBits'
	]);
}

// ── Export / Import ────────────────────────────────────────────────────────

export async function exportUserKeyBundleJwk(bundle: UserKeyBundle): Promise<UserKeyBundleJwk> {
	const [signingPublicKey, signingPrivateKey, encryptionPublicKey, encryptionPrivateKey] =
		await Promise.all([
			crypto.subtle.exportKey('jwk', bundle.signing.publicKey),
			crypto.subtle.exportKey('jwk', bundle.signing.privateKey),
			crypto.subtle.exportKey('jwk', bundle.encryption.publicKey),
			crypto.subtle.exportKey('jwk', bundle.encryption.privateKey)
		]);
	return { signingPublicKey, signingPrivateKey, encryptionPublicKey, encryptionPrivateKey };
}

export async function importUserKeyBundleJwk(jwk: UserKeyBundleJwk): Promise<UserKeyBundle> {
	const [signingPublic, signingPrivate, encryptionPublic, encryptionPrivate] = await Promise.all([
		crypto.subtle.importKey('jwk', jwk.signingPublicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
		crypto.subtle.importKey('jwk', jwk.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
		crypto.subtle.importKey('jwk', jwk.encryptionPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
		crypto.subtle.importKey('jwk', jwk.encryptionPrivateKey, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'])
	]);
	return {
		signing: { publicKey: signingPublic, privateKey: signingPrivate },
		encryption: { publicKey: encryptionPublic, privateKey: encryptionPrivate }
	};
}

export async function exportPublicKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
	return crypto.subtle.exportKey('jwk', key);
}

export async function importEcdhPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
	return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export async function importEcdsaPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
	return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

/** Serialize a JWK to a canonical JSON string (alphabetically sorted keys) for storage and lookup */
export function jwkToString(jwk: JsonWebKey): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(jwk as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		)
	);
}

export function stringToJwk(s: string): JsonWebKey {
	return JSON.parse(s) as JsonWebKey;
}

// ── Project keypair helpers ────────────────────────────────────────────────

/**
 * Exports an ECDH private key as raw PKCS#8 bytes for encrypted storage.
 * The caller is responsible for encrypting these bytes before persisting.
 */
export async function exportPrivateKeyPkcs8(key: CryptoKey): Promise<Uint8Array> {
	const buf = await crypto.subtle.exportKey('pkcs8', key);
	return new Uint8Array(buf);
}

/**
 * Imports an ECDH P-256 private key from raw PKCS#8 bytes.
 */
export async function importEcdhPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		pkcs8,
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveKey', 'deriveBits']
	);
}
