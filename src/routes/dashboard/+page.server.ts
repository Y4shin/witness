import { redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { deleteSession, SESSION_COOKIE_NAME } from '$lib/server/session';
import { db } from '$lib/server/db';

export const actions: Actions = {
	logout: async ({ cookies }) => {
		const token = cookies.get(SESSION_COOKIE_NAME);
		await deleteSession(token, db);
		cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		throw redirect(303, '/auth');
	}
};
