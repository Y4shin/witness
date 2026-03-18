/**
 * ECDSA P-256 signing and verification.
 * Signatures are returned as base64url-encoded DER format (raw IEEE P1363 from Web Crypto).
 */
import { encode, decode } from './encoding';

/**
 * Signs arbitrary data with an ECDSA P-256 private key.
 * Returns the signature as a base64url string.
 */
export async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
	const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
	return encode(new Uint8Array(sig));
}

/**
 * Verifies an ECDSA P-256 signature.
 */
export async function verify(
	publicKey: CryptoKey,
	signature: string,
	data: Uint8Array
): Promise<boolean> {
	return crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		publicKey,
		decode(signature),
		data
	);
}

/** Convenience: sign a UTF-8 string */
export async function signString(privateKey: CryptoKey, text: string): Promise<string> {
	return sign(privateKey, new TextEncoder().encode(text));
}

/** Convenience: verify a UTF-8 string */
export async function verifyString(
	publicKey: CryptoKey,
	signature: string,
	text: string
): Promise<boolean> {
	return verify(publicKey, signature, new TextEncoder().encode(text));
}
