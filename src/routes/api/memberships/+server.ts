import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import { getInviteInfo, claimInvite, InviteError } from '$lib/server/invites';
import type { JoinProjectRequest, JoinProjectResponse } from '$lib/api-types';

/**
 * POST /api/memberships
 * Creates a membership for the authenticated user by validating and consuming
 * an invite token.
 *
 * Body:
 *   - inviteToken: string — the invite token from the /invite/[token] redirect
 *   - encryptedProjectPrivateKey?: string — required for the first MODERATOR to
 *     set up the project's encrypted private key in their membership record
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;

	if (typeof b.inviteToken !== 'string' || !b.inviteToken) {
		throw error(400, 'inviteToken is required');
	}

	// Validate the invite (throws 404 / 410 if invalid)
	let inviteInfo: Awaited<ReturnType<typeof getInviteInfo>>;
	try {
		inviteInfo = await getInviteInfo(b.inviteToken, db);
	} catch (err) {
		if (err instanceof InviteError) throw error(err.statusCode, err.message);
		throw err;
	}

	// Prevent a user from joining a project they're already a member of
	const existing = await db.membership.findUnique({
		where: {
			userId_projectId: { userId: locals.user.id, projectId: inviteInfo.projectId }
		}
	});
	if (existing) throw error(409, 'Already a member of this project');

	// Consume the invite and create the membership atomically
	try {
		await claimInvite(b.inviteToken, db);
	} catch (err) {
		if (err instanceof InviteError) throw error(err.statusCode, err.message);
		throw err;
	}

	const encryptedProjectPrivateKey =
		typeof b.encryptedProjectPrivateKey === 'string' ? b.encryptedProjectPrivateKey : null;

	await db.membership.create({
		data: {
			userId: locals.user.id,
			projectId: inviteInfo.projectId,
			role: inviteInfo.role,
			encryptedProjectPrivateKey
		}
	});

	logger.info(
		{ userId: locals.user.id, projectId: inviteInfo.projectId, role: inviteInfo.role },
		'Membership created'
	);

	return json(
		{ projectId: inviteInfo.projectId, role: inviteInfo.role } satisfies JoinProjectResponse,
		{ status: 201 }
	);
};
