import type { Member, PrismaClient, Role } from '$lib/server/prisma/client';
import { logger } from '$lib/server/logger';
import { importEcdsaPublicKey, importEcdhPublicKey, stringToJwk } from '$lib/crypto';

export class MemberCreationError extends Error {
	constructor(
		public readonly statusCode: 400 | 409,
		message: string
	) {
		super(message);
		this.name = 'MemberCreationError';
	}
}

export interface CreateMemberData {
	projectId: string;
	signingPublicKey: string;
	encryptionPublicKey: string;
	encryptedName: string;
	encryptedContact: string;
	role: Role;
	encryptedProjectPrivateKey?: string | null;
}

/**
 * Creates a new Member record (merged identity + membership) after validating
 * that both public keys are well-formed P-256 JWK strings.
 * Throws MemberCreationError on validation failure or duplicate key.
 */
export async function createMember(data: CreateMemberData, db: PrismaClient): Promise<Member> {
	const {
		projectId,
		signingPublicKey,
		encryptionPublicKey,
		encryptedName,
		encryptedContact,
		role,
		encryptedProjectPrivateKey
	} = data;

	if (!projectId || !signingPublicKey || !encryptionPublicKey || !encryptedName || !encryptedContact) {
		throw new MemberCreationError(400, 'Missing required fields');
	}

	try {
		await importEcdsaPublicKey(stringToJwk(signingPublicKey));
	} catch {
		throw new MemberCreationError(400, 'Invalid signingPublicKey');
	}

	try {
		await importEcdhPublicKey(stringToJwk(encryptionPublicKey));
	} catch {
		throw new MemberCreationError(400, 'Invalid encryptionPublicKey');
	}

	try {
		const member = await db.member.create({
			data: {
				projectId,
				signingPublicKey,
				encryptionPublicKey,
				encryptedName,
				encryptedContact,
				role,
				encryptedProjectPrivateKey: encryptedProjectPrivateKey ?? null
			}
		});
		logger.info({ memberId: member.id, projectId, role }, 'Member registered');
		return member;
	} catch (err: unknown) {
		if (
			typeof err === 'object' &&
			err !== null &&
			'code' in err &&
			(err as { code: string }).code === 'P2002'
		) {
			throw new MemberCreationError(409, 'Key already registered');
		}
		throw err;
	}
}
