import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { GetSubmissionsResponse } from '$lib/api-types';

/**
 * GET /api/submissions/[id]
 *
 * Returns a single submission record with its encrypted payload and key bundles.
 * MODERATORs may fetch any submission in their project.
 * SUBMITTERs may only fetch their own submissions.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	const submission = await db.submission.findUnique({
		where: { id: params.id }
	});

	if (!submission) throw error(404, 'Submission not found');
	if (submission.projectId !== locals.member.projectId) throw error(403, 'Not a member of this project');

	if (locals.member.role === 'SUBMITTER' && submission.memberId !== locals.member.id) {
		throw error(403, 'Submitters can only access their own submissions');
	}

	// Re-use the same shape as the list endpoint for consistency
	return json({
		submissions: [
			{
				id: submission.id,
				memberId: submission.memberId,
				projectId: submission.projectId,
				type: submission.type,
				archiveCandidateUrl: submission.archiveCandidateUrl,
				archiveUrl: submission.archiveUrl,
				schemaVersion: submission.schemaVersion,
				encryptedPayload: submission.encryptedPayload,
				encryptedKeyProject: submission.encryptedKeyProject,
				encryptedKeyUser: submission.encryptedKeyUser,
				submitterSignature: submission.submitterSignature,
				createdAt: submission.createdAt.toISOString(),
				fileCount: await db.submissionFile.count({ where: { submissionId: submission.id } })
			}
		]
	} satisfies GetSubmissionsResponse);
};
