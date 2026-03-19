import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getInviteInfo, InviteError } from '$lib/server/invites';
import { logger } from '$lib/server/logger';
import type { InviteInfoResponse, RevokeInviteResponse } from '$lib/api-types';

/**
 * GET /api/invites/[token]
 * Validates the token and returns project info without consuming it.
 * Returns 404 for unknown tokens, 410 for expired/used tokens.
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const info = await getInviteInfo(params.token, db);
		return json({ projectId: info.projectId, projectName: info.projectName, role: info.role } satisfies InviteInfoResponse);
	} catch (err) {
		if (err instanceof InviteError) {
			throw error(err.statusCode, err.message);
		}
		throw err;
	}
};

/**
 * DELETE /api/invites/[token]
 * Revokes an invite link. Requires OBSERVER role in the linked project.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const invite = await db.inviteLink.findUnique({ where: { token: params.token } });
	if (!invite) throw error(404, 'Invite link not found');

	// Caller must be an observer in the linked project
	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId: invite.projectId } }
	});
	if (!membership || membership.role !== 'OBSERVER') {
		throw error(403, 'Only observers can revoke invite links');
	}

	await db.inviteLink.delete({ where: { token: params.token } });

	logger.info({ token: params.token, revokedBy: locals.user.id }, 'Invite link revoked');

	return json({ ok: true } satisfies RevokeInviteResponse);
};
