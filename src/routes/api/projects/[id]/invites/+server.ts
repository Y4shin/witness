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
	if (!locals.member) throw error(401, 'Authentication required');
	if (locals.member.projectId !== params.id) throw error(403, 'Not a member of this project');
	if (locals.member.role !== 'MODERATOR') throw error(403, 'Only moderators can view invite links');

	const invites = await db.inviteLink.findMany({
		where: { projectId: params.id },
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
