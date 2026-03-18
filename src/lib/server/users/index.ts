import type { PrismaClient, User } from '$lib/server/prisma/client';
import { logger } from '$lib/server/logger';
import { importEcdsaPublicKey, importEcdhPublicKey, stringToJwk } from '$lib/crypto';

export class UserCreationError extends Error {
	constructor(
		public readonly statusCode: 400 | 409,
		message: string
	) {
		super(message);
		this.name = 'UserCreationError';
	}
}

export interface CreateUserData {
	signingPublicKey: string;
	encryptionPublicKey: string;
	encryptedName: string;
	encryptedContact: string;
}

/**
 * Creates a new user record after validating that both public keys are
 * well-formed P-256 JWK strings. Throws UserCreationError on validation
 * failure or duplicate key.
 */
export async function createUser(data: CreateUserData, db: PrismaClient): Promise<User> {
	const { signingPublicKey, encryptionPublicKey, encryptedName, encryptedContact } = data;

	if (!signingPublicKey || !encryptionPublicKey || !encryptedName || !encryptedContact) {
		throw new UserCreationError(400, 'Missing required fields');
	}

	try {
		await importEcdsaPublicKey(stringToJwk(signingPublicKey));
	} catch {
		throw new UserCreationError(400, 'Invalid signingPublicKey');
	}

	try {
		await importEcdhPublicKey(stringToJwk(encryptionPublicKey));
	} catch {
		throw new UserCreationError(400, 'Invalid encryptionPublicKey');
	}

	try {
		const user = await db.user.create({
			data: { signingPublicKey, encryptionPublicKey, encryptedName, encryptedContact }
		});
		logger.info({ userId: user.id }, 'User registered');
		return user;
	} catch (err: unknown) {
		if (
			typeof err === 'object' &&
			err !== null &&
			'code' in err &&
			(err as { code: string }).code === 'P2002'
		) {
			throw new UserCreationError(409, 'Key already registered');
		}
		throw err;
	}
}
