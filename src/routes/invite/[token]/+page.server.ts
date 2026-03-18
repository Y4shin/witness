import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getInviteInfo, InviteError } from '$lib/server/invites';

export const load: PageServerLoad = async ({ params }) => {
	try {
		// Validate without consuming — the invite is consumed when the user completes
		// registration and their membership is created (POST /api/memberships).
		const info = await getInviteInfo(params.token, db);
		redirect(
			303,
			`/auth?projectId=${info.projectId}&inviteToken=${encodeURIComponent(params.token)}&role=${info.role}`
		);
	} catch (err) {
		if (err instanceof InviteError) {
			error(err.statusCode, err.message);
		}
		throw err;
	}
};
