import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { GetMembersResponse } from '$lib/api-types';

/**
 * GET /api/projects/[id]/members
 *
 * Returns all members of the project with their memberId, role, and encryption public key.
 * Requires membership (any role).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');
	if (locals.member.projectId !== params.id) throw error(403, 'Not a member of this project');

	const members = await db.member.findMany({
		where: { projectId: params.id },
		orderBy: { joinedAt: 'asc' }
	});

	return json({
		members: members.map((m) => ({
			memberId: m.id,
			role: m.role as 'SUBMITTER' | 'MODERATOR',
			encryptionPublicKey: m.encryptionPublicKey,
			joinedAt: m.joinedAt.toISOString()
		}))
	} satisfies GetMembersResponse);
};
