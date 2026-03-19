import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { PromoteRequest, PromoteResponse } from '$lib/api-types';

/**
 * POST /api/projects/[id]/promote
 *
 * Promotes a SUBMITTER to MODERATOR.
 * The caller must be an MODERATOR. They supply the project private key
 * already encrypted for the target user's public key.
 *
 * Returns:
 *   - 200 { ok: true } on success
 *   - 401 if not authenticated
 *   - 403 if caller is not an MODERATOR
 *   - 404 if target user is not a member of this project
 *   - 409 if target user is already an MODERATOR
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const { id: projectId } = params;

	// Caller must be an moderator
	const callerMembership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId } }
	});
	if (!callerMembership) throw error(403, 'Not a member of this project');
	if (callerMembership.role !== 'MODERATOR') throw error(403, 'Only moderators can promote members');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;
	if (typeof b.targetUserId !== 'string' || !b.targetUserId)
		throw error(400, 'targetUserId is required');
	if (typeof b.encryptedProjectPrivateKey !== 'string' || !b.encryptedProjectPrivateKey)
		throw error(400, 'encryptedProjectPrivateKey is required');

	const { targetUserId, encryptedProjectPrivateKey } = b as PromoteRequest;

	// Target must be a member of this project
	const targetMembership = await db.membership.findUnique({
		where: { userId_projectId: { userId: targetUserId, projectId } }
	});
	if (!targetMembership) throw error(404, 'Target user is not a member of this project');

	// Target must be a submitter (cannot promote an existing moderator)
	if (targetMembership.role === 'MODERATOR') throw error(409, 'User is already an moderator');

	await db.membership.update({
		where: { userId_projectId: { userId: targetUserId, projectId } },
		data: { role: 'MODERATOR', encryptedProjectPrivateKey }
	});

	logger.info(
		{ promotedBy: locals.user.id, promotedUser: targetUserId, projectId },
		'Submitter promoted to moderator'
	);

	return json({ ok: true } satisfies PromoteResponse);
};
