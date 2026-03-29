import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { MigrateFileRequest, MigrateResponse } from '$lib/api-types';

/**
 * PATCH /api/submissions/[id]/files/[fileId]/migrate
 *
 * Promotes a schema-v1 file to v2 by storing the encryptedMeta ciphertext
 * (which the client computed by encrypting { mimeType } with the existing
 * per-file symmetric key) and clearing the legacy plaintext mimeType column.
 *
 * Authentication is via the normal session cookie.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	const file = await db.submissionFile.findUnique({
		where: { id: params.fileId },
		include: { submission: true }
	});
	if (!file) throw error(404, 'File not found');
	if (file.submission.projectId !== locals.member.projectId) throw error(403, 'Not a member of this project');

	// Submitters may only migrate files belonging to their own submissions.
	if (locals.member.role === 'SUBMITTER' && file.submission.memberId !== locals.member.id) {
		throw error(403, 'Submitters can only migrate their own files');
	}

	// Already migrated — idempotent no-op.
	if (file.schemaVersion >= 2) {
		return json({ ok: true } satisfies MigrateResponse);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;
	if (typeof b.encryptedMeta !== 'string' || !b.encryptedMeta)
		throw error(400, 'encryptedMeta is required');

	const { encryptedMeta } = b as unknown as MigrateFileRequest;

	await db.submissionFile.update({
		where: { id: params.fileId },
		data: {
			encryptedMeta,
			mimeType: null,
			schemaVersion: 2
		}
	});

	logger.info(
		{ fileId: params.fileId, submissionId: params.id, memberId: locals.member.id },
		'File migrated to schema v2'
	);

	return json({ ok: true } satisfies MigrateResponse);
};
