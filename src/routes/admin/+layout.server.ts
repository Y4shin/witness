import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { ADMIN_COOKIE_NAME, validateAdminSession } from '$lib/server/admin-auth';

export const load: LayoutServerLoad = async ({ cookies, url }) => {
	// The login page handles its own auth — let it through
	if (url.pathname === '/admin/login') return {};

	if (!validateAdminSession(cookies.get(ADMIN_COOKIE_NAME))) {
		redirect(303, '/admin/login');
	}

	return {};
};
