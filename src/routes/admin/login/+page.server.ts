import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	ADMIN_COOKIE_NAME,
	ADMIN_COOKIE_BASE,
	createAdminSession,
	getAdminAuthConfig,
	validateAdminSession,
	verifyAdminPassword
} from '$lib/server/admin-auth';

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const authConfig = getAdminAuthConfig();
		if (authConfig.mode !== 'password') {
			return fail(400, { error: 'Password login is not enabled.' });
		}

		const data = await request.formData();
		const password = data.get('password');

		if (typeof password !== 'string' || !password) {
			return fail(400, { error: 'Password is required' });
		}

		if (!verifyAdminPassword(password)) {
			return fail(401, { error: 'Incorrect password' });
		}

		const token = createAdminSession({ source: 'password' });
		const secure = url.protocol === 'https:';
		cookies.set(ADMIN_COOKIE_NAME, token, { ...ADMIN_COOKIE_BASE, secure });

		redirect(303, '/admin');
	}
};

export const load: PageServerLoad = async ({ cookies, url }) => {
	if (validateAdminSession(cookies.get(ADMIN_COOKIE_NAME))) {
		redirect(303, '/admin');
	}

	return {
		authMode: getAdminAuthConfig().mode,
		error: url.searchParams.get('error')
	};
};
