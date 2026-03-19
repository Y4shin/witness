import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { logger } from '$lib/server/logger';

export const ADMIN_COOKIE_NAME = 'admin-session';

/** 8-hour admin session lifetime */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const ADMIN_COOKIE_BASE = {
	httpOnly: true,
	sameSite: 'lax',
	path: '/admin',
	maxAge: SESSION_TTL_MS / 1000
} as const;

// ── In-memory session store ──────────────────────────────────────────────────
// Admin sessions don't need to survive restarts — the admin can re-authenticate.

const activeSessions = new Map<string, number>(); // token → expiresAt (ms)

/** Hashes a string with SHA-256 to enable constant-time comparison. */
function sha256(s: string): Buffer {
	return crypto.createHash('sha256').update(s).digest();
}

/** Returns true if ADMIN_PASSWORD is configured in the environment. */
export function isAdminPasswordConfigured(): boolean {
	return Boolean(env.ADMIN_PASSWORD);
}

/**
 * Constant-time password check against the ADMIN_PASSWORD env variable.
 * Returns false (not an error) if the env variable is not set.
 */
export function verifyAdminPassword(input: string): boolean {
	const expected = env.ADMIN_PASSWORD;
	if (!expected) return false;
	return crypto.timingSafeEqual(sha256(input), sha256(expected));
}

/** Creates a new admin session and returns the opaque token. */
export function createAdminSession(): string {
	const token = crypto.randomBytes(32).toString('base64url');
	activeSessions.set(token, Date.now() + SESSION_TTL_MS);
	logger.info({}, 'Admin session created');
	return token;
}

/** Returns true if the token maps to a live admin session. */
export function validateAdminSession(token: string | undefined): boolean {
	if (!token) return false;
	const expiresAt = activeSessions.get(token);
	if (expiresAt === undefined) return false;
	if (Date.now() > expiresAt) {
		activeSessions.delete(token);
		return false;
	}
	return true;
}

/** Removes an admin session (logout). */
export function revokeAdminSession(token: string): void {
	activeSessions.delete(token);
	logger.info({}, 'Admin session revoked');
}
