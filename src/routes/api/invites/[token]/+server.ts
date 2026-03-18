import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getInviteInfo, InviteError } from '$lib/server/invites';
import type { InviteInfoResponse } from '$lib/api-types';

/**
 * GET /api/invites/[token]
 * Validates the token and returns project info without consuming it.
 * Returns 404 for unknown tokens, 410 for expired/used tokens.
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const info = await getInviteInfo(params.token, db);
		return json({ projectId: info.projectId, projectName: info.projectName, role: info.role } satisfies InviteInfoResponse);
	} catch (err) {
		if (err instanceof InviteError) {
			throw error(err.statusCode, err.message);
		}
		throw err;
	}
};
