import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { claimInvite, InviteError } from '$lib/server/invites';

export const load: PageServerLoad = async ({ params }) => {
	try {
		const projectId = await claimInvite(params.token, db);
		redirect(303, `/auth?projectId=${projectId}`);
	} catch (err) {
		if (err instanceof InviteError) {
			error(err.statusCode, err.message);
		}
		throw err;
	}
};
