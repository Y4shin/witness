import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { GetProjectInvitesResponse } from '$lib/api-types';

/**
 * GET /api/projects/[id]/invites
 *
 * Returns all active (not fully-used) invite links for the project.
 * Requires MODERATOR role.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const { id: projectId } = params;

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId } }
	});
	if (!membership) throw error(403, 'Not a member of this project');
	if (membership.role !== 'MODERATOR') throw error(403, 'Only moderators can view invite links');

	const invites = await db.inviteLink.findMany({
		where: { projectId },
		orderBy: { createdAt: 'desc' }
	});

	return json({
		invites: invites.map((i) => ({
			id: i.id,
			token: i.token,
			role: i.role as 'SUBMITTER' | 'MODERATOR',
			maxUses: i.maxUses,
			usedCount: i.usedCount,
			expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
			createdAt: i.createdAt.toISOString()
		}))
	} satisfies GetProjectInvitesResponse);
};
