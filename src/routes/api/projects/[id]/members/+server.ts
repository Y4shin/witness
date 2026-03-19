import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { GetMembersResponse } from '$lib/api-types';

/**
 * GET /api/projects/[id]/members
 *
 * Returns all members of the project with their userId, role, and encryption public key.
 * Requires membership (any role).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const { id: projectId } = params;

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId } }
	});
	if (!membership) throw error(403, 'Not a member of this project');

	const memberships = await db.membership.findMany({
		where: { projectId },
		include: { user: { select: { encryptionPublicKey: true } } },
		orderBy: { joinedAt: 'asc' }
	});

	return json({
		members: memberships.map((m) => ({
			userId: m.userId,
			role: m.role as 'SUBMITTER' | 'OBSERVER',
			encryptionPublicKey: m.user.encryptionPublicKey,
			joinedAt: m.joinedAt.toISOString()
		}))
	} satisfies GetMembersResponse);
};
