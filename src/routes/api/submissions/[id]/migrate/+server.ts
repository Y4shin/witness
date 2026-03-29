import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { MigrateSubmissionRequest, MigrateResponse } from '$lib/api-types';

/**
 * PATCH /api/submissions/[id]/migrate
 *
 * Promotes a schema-v1 submission to v2 by storing the re-encrypted payload
 * (which now contains type/archiveUrl inside the DecryptedPayload envelope)
 * and clearing the legacy plaintext columns.
 *
 * Called client-side after the client has decrypted the old payload, built the
 * DecryptedPayload envelope, and re-encrypted it.  Authentication is via the
 * normal session cookie — no challenge/signature required.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	const submission = await db.submission.findUnique({ where: { id: params.id } });
	if (!submission) throw error(404, 'Submission not found');
	if (submission.projectId !== locals.member.projectId) throw error(403, 'Not a member of this project');

	// Submitters may only migrate their own submissions; moderators may migrate any.
	if (locals.member.role === 'SUBMITTER' && submission.memberId !== locals.member.id) {
		throw error(403, 'Submitters can only migrate their own submissions');
	}

	// Already migrated — idempotent no-op.
	if (submission.schemaVersion >= 2) {
		return json({ ok: true } satisfies MigrateResponse);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;
	if (typeof b.encryptedPayload !== 'string' || !b.encryptedPayload)
		throw error(400, 'encryptedPayload is required');
	if (typeof b.encryptedKeyProject !== 'string' || !b.encryptedKeyProject)
		throw error(400, 'encryptedKeyProject is required');
	if (typeof b.encryptedKeyUser !== 'string' || !b.encryptedKeyUser)
		throw error(400, 'encryptedKeyUser is required');

	const { encryptedPayload, encryptedKeyProject, encryptedKeyUser } =
		b as unknown as MigrateSubmissionRequest;

	await db.submission.update({
		where: { id: params.id },
		data: {
			encryptedPayload,
			encryptedKeyProject,
			encryptedKeyUser,
			type: null,
			archiveCandidateUrl: null,
			archiveUrl: null,
			schemaVersion: 2
		}
	});

	logger.info(
		{ submissionId: params.id, memberId: locals.member.id },
		'Submission migrated to schema v2'
	);

	return json({ ok: true } satisfies MigrateResponse);
};
