import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifyChallenge, AuthError } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_BASE } from '$lib/server/session';
import type { VerifyResponse } from '$lib/api-types';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	try {
		const { token } = await verifyChallenge(body, db);
		const secure = url.protocol === 'https:';
		cookies.set(SESSION_COOKIE_NAME, token, { ...SESSION_COOKIE_BASE, secure });
		return json({ ok: true } satisfies VerifyResponse);
	} catch (err) {
		if (err instanceof AuthError) {
			throw error(err.statusCode, err.message);
		}
		throw err;
	}
};
