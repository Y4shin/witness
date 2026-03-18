/**
 * Base64url encoding utilities (RFC 4648 §5, no padding).
 * Works in both browser (Web Crypto) and Node.js environments.
 */

export function encode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function decode(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
