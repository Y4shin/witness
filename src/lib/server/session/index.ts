import { randomBytes } from 'crypto';
import type { PrismaClient, User } from '$lib/server/prisma/client';
import { logger } from '$lib/server/logger';

export const SESSION_COOKIE_NAME = 'session';

/** 7 days in milliseconds */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Base cookie options. The `secure` flag must be set by the caller based on
 * whether the request is over HTTPS (use `event.url.protocol === 'https:'`).
 */
export const SESSION_COOKIE_BASE = {
	httpOnly: true,
	sameSite: 'lax',
	path: '/',
	maxAge: SESSION_DURATION_MS / 1000
} as const;

export function generateToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * Creates a new session for the given user and returns the session token.
 * The caller is responsible for setting the token as a cookie.
 */
export async function createSession(userId: string, db: PrismaClient): Promise<string> {
	const token = generateToken();
	const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

	await db.session.create({ data: { userId, token, expiresAt } });

	logger.info({ userId }, 'Session created');
	return token;
}

/**
 * Validates a session token and returns the associated user, or null if the
 * token is missing, invalid, or expired. Expired sessions are lazily deleted.
 */
export async function validateSession(
	token: string | undefined,
	db: PrismaClient
): Promise<User | null> {
	if (!token) return null;

	const session = await db.session.findUnique({
		where: { token },
		include: { user: true }
	});

	if (!session) return null;

	if (session.expiresAt < new Date()) {
		await db.session.delete({ where: { token } }).catch(() => {});
		logger.info({ userId: session.userId }, 'Expired session removed');
		return null;
	}

	return session.user;
}

/**
 * Deletes a session by token. No-ops silently if the token does not exist.
 * The caller is responsible for clearing the cookie.
 */
export async function deleteSession(token: string | undefined, db: PrismaClient): Promise<void> {
	if (!token) return;
	await db.session.deleteMany({ where: { token } });
	logger.info({}, 'Session deleted');
}
