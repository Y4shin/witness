import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { GetSubmissionsResponse } from '$lib/api-types';

/**
 * GET /api/projects/[id]/submissions
 *
 * Returns submissions for the project.
 * - MODERATOR: all submissions
 * - SUBMITTER: only their own submissions
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const { id: projectId } = params;

	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId } }
	});
	if (!membership) throw error(403, 'Not a member of this project');

	const where =
		membership.role === 'MODERATOR'
			? { projectId }
			: { projectId, userId: locals.user.id };

	const rows = await db.submission.findMany({
		where,
		orderBy: { createdAt: 'desc' }
	});

	logger.info(
		{ projectId, userId: locals.user.id, role: membership.role, count: rows.length },
		'Submissions fetched'
	);

	return json({
		submissions: rows.map((s) => ({
			id: s.id,
			userId: s.userId,
			projectId: s.projectId,
			encryptedPayload: s.encryptedPayload,
			encryptedKeyProject: s.encryptedKeyProject,
			encryptedKeyUser: s.encryptedKeyUser,
			submitterSignature: s.submitterSignature,
			createdAt: s.createdAt.toISOString()
		}))
	} satisfies GetSubmissionsResponse);
};
