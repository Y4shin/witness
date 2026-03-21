import { error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { readFile } from 'node:fs/promises';

/**
 * GET /api/submissions/[id]/files/[fileId]
 *
 * Returns the raw encrypted bytes of a submission file.
 * MODERATORs may download any file in their project.
 * SUBMITTERs may only download files from their own submissions.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	const file = await db.submissionFile.findUnique({
		where: { id: params.fileId },
		include: { submission: { select: { projectId: true, id: true, memberId: true } } }
	});

	if (!file) throw error(404, 'File not found');
	if (file.submission.id !== params.id) throw error(404, 'File not found');
	if (file.submission.projectId !== locals.member.projectId) throw error(403, 'Not a member of this project');

	// Submitters can only download files from their own submissions
	if (locals.member.role === 'SUBMITTER' && file.submission.memberId !== locals.member.id) {
		throw error(403, 'Submitters can only access their own submissions');
	}

	let bytes: Buffer;
	try {
		bytes = await readFile(file.storagePath);
	} catch {
		throw error(500, 'File data not found on server');
	}

	return new Response(bytes, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(bytes.length)
		}
	});
};
