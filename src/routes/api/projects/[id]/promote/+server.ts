import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { PromoteRequest, PromoteResponse } from '$lib/api-types';

/**
 * POST /api/projects/[id]/promote
 *
 * Promotes a SUBMITTER to MODERATOR.
 * The caller must be a MODERATOR. They supply the project private key
 * already encrypted for the target member's public key.
 *
 * Returns:
 *   - 200 { ok: true } on success
 *   - 401 if not authenticated
 *   - 403 if caller is not a MODERATOR
 *   - 404 if target member is not a member of this project
 *   - 409 if target member is already a MODERATOR
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');
	if (locals.member.projectId !== params.id) throw error(403, 'Not a member of this project');
	if (locals.member.role !== 'MODERATOR') throw error(403, 'Only moderators can promote members');

	const { id: projectId } = params;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;
	if (typeof b.targetMemberId !== 'string' || !b.targetMemberId)
		throw error(400, 'targetMemberId is required');
	if (typeof b.encryptedProjectPrivateKey !== 'string' || !b.encryptedProjectPrivateKey)
		throw error(400, 'encryptedProjectPrivateKey is required');

	const { targetMemberId, encryptedProjectPrivateKey } = b as PromoteRequest;

	// Target must be a member of this project
	const target = await db.member.findUnique({
		where: { id: targetMemberId }
	});
	if (!target || target.projectId !== projectId) throw error(404, 'Target member not found in this project');
	if (target.role === 'MODERATOR') throw error(409, 'Member is already a moderator');

	await db.member.update({
		where: { id: targetMemberId },
		data: { role: 'MODERATOR', encryptedProjectPrivateKey }
	});

	logger.info(
		{ promotedBy: locals.member.id, promotedMember: targetMemberId, projectId },
		'Submitter promoted to moderator'
	);

	return json({ ok: true } satisfies PromoteResponse);
};
