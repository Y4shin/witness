import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import {
	verifyAdminPassword,
	createAdminSession,
	ADMIN_COOKIE_NAME,
	ADMIN_COOKIE_BASE,
	validateAdminSession
} from '$lib/server/admin-auth';

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const password = data.get('password');

		if (typeof password !== 'string' || !password) {
			return fail(400, { error: 'Password is required' });
		}

		if (!verifyAdminPassword(password)) {
			return fail(401, { error: 'Incorrect password' });
		}

		const token = createAdminSession();
		const secure = url.protocol === 'https:';
		cookies.set(ADMIN_COOKIE_NAME, token, { ...ADMIN_COOKIE_BASE, secure });

		redirect(303, '/admin');
	}
};

export async function load({ cookies }) {
	// Already authenticated — skip login page
	if (validateAdminSession(cookies.get(ADMIN_COOKIE_NAME))) {
		redirect(303, '/admin');
	}
	return {};
}
