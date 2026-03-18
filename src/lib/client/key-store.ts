/**
 * localStorage key bundle management.
 * Keys are stored as raw JWK objects so they can be re-imported on any visit.
 */
import type { UserKeyBundleJwk } from '$lib/crypto/keys';

export const KEYS_STORAGE_KEY = 'rt:keys';

export function loadStoredKeys(): UserKeyBundleJwk | null {
	try {
		const raw = localStorage.getItem(KEYS_STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as UserKeyBundleJwk;
	} catch {
		return null;
	}
}

export function saveKeys(bundle: UserKeyBundleJwk): void {
	localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(bundle));
}

export function clearKeys(): void {
	localStorage.removeItem(KEYS_STORAGE_KEY);
}

export function hasStoredKeys(): boolean {
	return localStorage.getItem(KEYS_STORAGE_KEY) !== null;
}
