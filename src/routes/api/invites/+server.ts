import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createInvite } from '$lib/server/invites';
import type { CreateInviteResponse } from '$lib/api-types';

/**
 * POST /api/invites
 * Creates a new invite link. Requires an authenticated session with MODERATOR
 * role in the target project.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;

	if (typeof b.projectId !== 'string' || !b.projectId) {
		throw error(400, 'projectId is required');
	}
	if (b.role !== 'SUBMITTER' && b.role !== 'MODERATOR') {
		throw error(400, "role must be 'SUBMITTER' or 'MODERATOR'");
	}

	// Verify the requester is a MODERATOR in the target project
	if (locals.member.projectId !== b.projectId || locals.member.role !== 'MODERATOR') {
		throw error(403, 'Only MODERATORs can create invite links');
	}

	const maxUses = typeof b.maxUses === 'number' ? b.maxUses : null;
	const expiresAt =
		typeof b.expiresAt === 'string' && b.expiresAt ? new Date(b.expiresAt) : null;

	if (expiresAt !== null && expiresAt <= new Date()) {
		throw error(400, 'expiresAt must be in the future');
	}

	const invite = await createInvite(
		{
			projectId: b.projectId,
			role: b.role,
			maxUses,
			expiresAt,
			createdByMember: locals.member.id
		},
		db
	);

	return json({ token: invite.token } satisfies CreateInviteResponse, { status: 201 });
};
