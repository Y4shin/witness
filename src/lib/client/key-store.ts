/**
 * localStorage membership management.
 *
 * Each project membership is stored independently, keyed by projectId.
 * A single physical person joining N projects produces N unlinked local entries,
 * mirroring the per-project identity model on the server.
 *
 * Storage key: 'rt:memberships'  →  Record<projectId, StoredMembership>
 *
 * Legacy key 'rt:keys' (single bundle, no projectId) is detected on load.
 * If present and 'rt:memberships' is absent, callers should prompt re-registration.
 */
import type { UserKeyBundleJwk } from '$lib/crypto/keys';

export const KEYS_STORAGE_KEY = 'rt:keys'; // Legacy — kept for migration detection
const MEMBERSHIPS_STORAGE_KEY = 'rt:memberships';

export interface StoredMembership {
	bundle: UserKeyBundleJwk;
	projectName: string;
	role: 'SUBMITTER' | 'MODERATOR';
}

type StoredMemberships = Record<string, StoredMembership>; // keyed by projectId

// ── Internal helpers ───────────────────────────────────────────────────────────

function readAll(): StoredMemberships {
	try {
		const raw = localStorage.getItem(MEMBERSHIPS_STORAGE_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as StoredMemberships;
	} catch {
		return {};
	}
}

function writeAll(map: StoredMemberships): void {
	localStorage.setItem(MEMBERSHIPS_STORAGE_KEY, JSON.stringify(map));
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function loadMemberships(): StoredMemberships {
	return readAll();
}

export function loadMembershipForProject(projectId: string): StoredMembership | null {
	return readAll()[projectId] ?? null;
}

export function saveMembership(
	projectId: string,
	bundle: UserKeyBundleJwk,
	projectName: string,
	role: 'SUBMITTER' | 'MODERATOR'
): void {
	const map = readAll();
	map[projectId] = { bundle, projectName, role };
	writeAll(map);
}

export function listProjectMemberships(): { projectId: string; projectName: string; role: 'SUBMITTER' | 'MODERATOR' }[] {
	return Object.entries(readAll()).map(([projectId, m]) => ({
		projectId,
		projectName: m.projectName,
		role: m.role
	}));
}

export function clearMembership(projectId: string): void {
	const map = readAll();
	delete map[projectId];
	writeAll(map);
}

export function clearAllMemberships(): void {
	localStorage.removeItem(MEMBERSHIPS_STORAGE_KEY);
}

/** True if the user has any stored memberships. */
export function hasMemberships(): boolean {
	return Object.keys(readAll()).length > 0;
}

/**
 * True if only the legacy single-key storage exists (pre-v2).
 * Callers should show a "please re-register" notice and call clearLegacyKeys().
 */
export function hasLegacyKeysOnly(): boolean {
	return (
		localStorage.getItem(KEYS_STORAGE_KEY) !== null &&
		localStorage.getItem(MEMBERSHIPS_STORAGE_KEY) === null
	);
}

export function clearLegacyKeys(): void {
	localStorage.removeItem(KEYS_STORAGE_KEY);
}

// ── Backwards-compat shim for pages not yet migrated to per-project API ───────

/** @deprecated Use loadMembershipForProject() instead. */
export function loadStoredKeys(): UserKeyBundleJwk | null {
	// Return first available bundle (single-project assumption — remove after Step 14)
	const first = Object.values(readAll())[0];
	return first?.bundle ?? null;
}
