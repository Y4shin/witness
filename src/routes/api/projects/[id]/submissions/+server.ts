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
	if (!locals.member) throw error(401, 'Authentication required');
	if (locals.member.projectId !== params.id) throw error(403, 'Not a member of this project');

	const { id: projectId } = params;

	const where =
		locals.member.role === 'MODERATOR'
			? { projectId }
			: { projectId, memberId: locals.member.id };

	const rows = await db.submission.findMany({
		where,
		orderBy: { createdAt: 'desc' },
		include: { _count: { select: { files: true } } }
	});

	logger.info(
		{ projectId, memberId: locals.member.id, role: locals.member.role, count: rows.length },
		'Submissions fetched'
	);

	return json({
		submissions: rows.map((s) => ({
			id: s.id,
			memberId: s.memberId,
			projectId: s.projectId,
			type: s.type,
			archiveCandidateUrl: s.archiveCandidateUrl,
			archiveUrl: s.archiveUrl,
			schemaVersion: s.schemaVersion,
			encryptedPayload: s.encryptedPayload,
			encryptedKeyProject: s.encryptedKeyProject,
			encryptedKeyUser: s.encryptedKeyUser,
			submitterSignature: s.submitterSignature,
			createdAt: s.createdAt.toISOString(),
			fileCount: s._count.files
		}))
	} satisfies GetSubmissionsResponse);
};
