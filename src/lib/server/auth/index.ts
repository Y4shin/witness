import { randomBytes } from 'crypto';
import type { PrismaClient } from '$lib/server/prisma/client';
import { logger } from '$lib/server/logger';
import { importEcdsaPublicKey, stringToJwk, verify as ecdsaVerify } from '$lib/crypto';
import { createSession } from '$lib/server/session';

/** How long a challenge nonce is valid */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Structured error thrown by auth service functions.
 * Callers should map statusCode to an HTTP response.
 */
export class AuthError extends Error {
	constructor(
		public readonly statusCode: 400 | 401,
		message: string
	) {
		super(message);
		this.name = 'AuthError';
	}
}

/**
 * Generates a single-use nonce, stores it with a short TTL, and returns it.
 */
export async function issueChallenge(db: PrismaClient): Promise<string> {
	const nonce = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
	await db.challenge.create({ data: { nonce, expiresAt } });
	logger.info({}, 'Challenge issued');
	return nonce;
}

export interface VerifyResult {
	userId: string;
	token: string;
}

/**
 * Validates a challenge-response:
 * 1. Looks up and consumes the nonce (single-use).
 * 2. Checks it has not expired.
 * 3. Finds the user by their signing public key.
 * 4. Verifies the ECDSA signature over the nonce.
 * 5. Creates a new session and returns the token.
 *
 * Throws `AuthError` on any validation failure.
 */
export async function verifyChallenge(body: unknown, db: PrismaClient): Promise<VerifyResult> {
	if (!body || typeof body !== 'object') {
		throw new AuthError(400, 'Invalid request body');
	}

	const { signingPublicKey, nonce, signature } = body as Record<string, unknown>;

	if (
		typeof signingPublicKey !== 'string' ||
		typeof nonce !== 'string' ||
		typeof signature !== 'string'
	) {
		throw new AuthError(400, 'Missing or invalid required fields: signingPublicKey, nonce, signature');
	}

	// Find and immediately consume the nonce (prevents replay regardless of outcome)
	const challenge = await db.challenge.findUnique({ where: { nonce } });
	if (challenge) {
		await db.challenge.delete({ where: { nonce } }).catch(() => {});
	}

	if (!challenge || challenge.expiresAt < new Date()) {
		logger.warn({ nonce: nonce.slice(0, 8) }, 'Challenge rejected: unknown or expired nonce');
		throw new AuthError(401, 'Invalid or expired nonce');
	}

	// Look up user
	const user = await db.user.findUnique({ where: { signingPublicKey } });
	if (!user) {
		logger.warn({}, 'Challenge rejected: unknown signing key');
		throw new AuthError(401, 'Unknown public key');
	}

	// Verify signature over the raw nonce bytes
	let valid: boolean;
	try {
		const publicKey = await importEcdsaPublicKey(stringToJwk(signingPublicKey));
		valid = await ecdsaVerify(publicKey, signature, new TextEncoder().encode(nonce));
	} catch (err) {
		logger.warn({ err, userId: user.id }, 'Signature verification error');
		throw new AuthError(401, 'Signature verification failed');
	}

	if (!valid) {
		logger.warn({ userId: user.id }, 'Challenge rejected: invalid signature');
		throw new AuthError(401, 'Invalid signature');
	}

	const token = await createSession(user.id, db);
	logger.info({ userId: user.id }, 'Auth verified, session created');
	return { userId: user.id, token };
}
