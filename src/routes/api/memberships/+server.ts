import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import { getInviteInfo, claimInvite, InviteError } from '$lib/server/invites';
import { createMember, MemberCreationError } from '$lib/server/members';
import type { JoinProjectRequest, JoinProjectResponse } from '$lib/api-types';

/**
 * POST /api/memberships
 *
 * Creates a new Member (identity + membership) by validating an invite token.
 * No prior session required — this is the registration endpoint.
 *
 * Body:
 *   inviteToken              — the invite token
 *   signingPublicKey         — ECDSA P-256 JWK string
 *   encryptionPublicKey      — ECDH P-256 JWK string
 *   encryptedName            — name encrypted with project public key
 *   encryptedContact         — contact encrypted with project public key
 *   encryptedProjectPrivateKey? — required for the first MODERATOR
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;

	if (typeof b.inviteToken !== 'string' || !b.inviteToken)
		throw error(400, 'inviteToken is required');
	if (typeof b.signingPublicKey !== 'string' || !b.signingPublicKey)
		throw error(400, 'signingPublicKey is required');
	if (typeof b.encryptionPublicKey !== 'string' || !b.encryptionPublicKey)
		throw error(400, 'encryptionPublicKey is required');
	if (typeof b.encryptedName !== 'string' || !b.encryptedName)
		throw error(400, 'encryptedName is required');
	if (typeof b.encryptedContact !== 'string' || !b.encryptedContact)
		throw error(400, 'encryptedContact is required');

	// Validate invite (throws 404 / 410 if invalid)
	let inviteInfo: Awaited<ReturnType<typeof getInviteInfo>>;
	try {
		inviteInfo = await getInviteInfo(b.inviteToken, db);
	} catch (err) {
		if (err instanceof InviteError) throw error(err.statusCode, err.message);
		throw err;
	}

	const encryptedProjectPrivateKey =
		typeof b.encryptedProjectPrivateKey === 'string' ? b.encryptedProjectPrivateKey : null;

	// Create member + consume invite atomically via transaction
	let member: Awaited<ReturnType<typeof createMember>>;
	try {
		await claimInvite(b.inviteToken, db);
		member = await createMember(
			{
				projectId: inviteInfo.projectId,
				signingPublicKey: b.signingPublicKey,
				encryptionPublicKey: b.encryptionPublicKey,
				encryptedName: b.encryptedName,
				encryptedContact: b.encryptedContact,
				role: inviteInfo.role,
				encryptedProjectPrivateKey
			},
			db
		);
	} catch (err) {
		if (err instanceof InviteError) throw error(err.statusCode, err.message);
		if (err instanceof MemberCreationError) throw error(err.statusCode, err.message);
		throw err;
	}

	logger.info(
		{ memberId: member.id, projectId: inviteInfo.projectId, role: inviteInfo.role },
		'Member registered and joined project'
	);

	return json(
		{
			memberId: member.id,
			projectId: inviteInfo.projectId,
			projectName: inviteInfo.projectName,
			role: inviteInfo.role
		} satisfies JoinProjectResponse,
		{ status: 201 }
	);
};
