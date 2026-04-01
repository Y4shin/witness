import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import {
	ADMIN_COOKIE_NAME,
	getAdminAuthConfig,
	validateAdminSession
} from '$lib/server/admin-auth';

export const load: LayoutServerLoad = async ({ cookies, url }) => {
	getAdminAuthConfig();

	// The login page and OIDC callback routes handle their own auth flow.
	if (url.pathname.startsWith('/admin/login')) return {};

	if (!validateAdminSession(cookies.get(ADMIN_COOKIE_NAME))) {
		redirect(303, '/admin/login');
	}

	return {};
};
