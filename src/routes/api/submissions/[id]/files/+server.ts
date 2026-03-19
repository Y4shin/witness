import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { UploadFileRequest, UploadFileResponse } from '$lib/api-types';

/**
 * POST /api/submissions/[id]/files
 *
 * Uploads an encrypted file attached to a submission.
 * The file bytes are already encrypted client-side; the server stores them opaquely.
 */
export const POST: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const { id: submissionId } = params;

	// Verify submission exists and belongs to this user (or user is a moderator of the project)
	const submission = await db.submission.findUnique({
		where: { id: submissionId },
		include: { project: { include: { memberships: { where: { userId: locals.user.id } } } } }
	});
	if (!submission) throw error(404, 'Submission not found');

	const membership = submission.project.memberships[0];
	if (!membership) throw error(403, 'Not a member of this project');

	// Only the submitter can upload files to their own submission
	if (submission.userId !== locals.user.id) {
		throw error(403, 'You can only upload files to your own submissions');
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;

	if (typeof b.fieldName !== 'string' || !b.fieldName) throw error(400, 'fieldName is required');
	if (typeof b.encryptedData !== 'string' || !b.encryptedData) throw error(400, 'encryptedData is required');
	if (typeof b.encryptedKey !== 'string' || !b.encryptedKey) throw error(400, 'encryptedKey is required');
	if (typeof b.encryptedKeyUser !== 'string' || !b.encryptedKeyUser) throw error(400, 'encryptedKeyUser is required');

	const { fieldName, mimeType, encryptedData, encryptedKey, encryptedKeyUser } = b as unknown as UploadFileRequest;

	// Decode base64url to bytes
	const base64 = encryptedData.replace(/-/g, '+').replace(/_/g, '/');
	const binaryStr = atob(base64);
	const bytes = new Uint8Array(binaryStr.length);
	for (let i = 0; i < binaryStr.length; i++) {
		bytes[i] = binaryStr.charCodeAt(i);
	}

	// Generate a storage path (fileId will be auto-assigned by DB)
	const uploadDir = join('uploads', submission.projectId, submissionId!);
	const fileId = crypto.randomUUID();
	const storagePath = join(uploadDir, `${fileId}.enc`);

	await mkdir(uploadDir, { recursive: true });
	await writeFile(storagePath, bytes);

	const file = await db.submissionFile.create({
		data: {
			submissionId: submissionId!,
			fieldName,
			mimeType: mimeType ?? null,
			storagePath,
			encryptedKey,
			encryptedKeyUser,
			sizeBytes: bytes.length
		}
	});

	logger.info(
		{ fileId: file.id, submissionId, fieldName, sizeBytes: file.sizeBytes },
		'File uploaded'
	);

	return json({ fileId: file.id } satisfies UploadFileResponse, { status: 201 });
};
