import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { deleteSession, SESSION_COOKIE_NAME } from '$lib/server/session';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE_NAME);
	await deleteSession(token, db);
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	logger.info({}, 'Logout');
	return json({ ok: true });
};
