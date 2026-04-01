import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	ADMIN_OIDC_CODE_VERIFIER_COOKIE_NAME,
	ADMIN_OIDC_COOKIE_BASE,
	ADMIN_OIDC_NONCE_COOKIE_NAME,
	ADMIN_OIDC_STATE_COOKIE_NAME,
	createAdminOidcAuthorizationRequest
} from '$lib/server/admin-auth';
import { logger } from '$lib/server/logger';

export const GET: RequestHandler = async ({ cookies, url }) => {
	try {
		const request = await createAdminOidcAuthorizationRequest(url);
		const secure = url.protocol === 'https:';

		cookies.set(ADMIN_OIDC_STATE_COOKIE_NAME, request.state, {
			...ADMIN_OIDC_COOKIE_BASE,
			secure
		});
		cookies.set(ADMIN_OIDC_NONCE_COOKIE_NAME, request.nonce, {
			...ADMIN_OIDC_COOKIE_BASE,
			secure
		});
		cookies.set(ADMIN_OIDC_CODE_VERIFIER_COOKIE_NAME, request.codeVerifier, {
			...ADMIN_OIDC_COOKIE_BASE,
			secure
		});

		redirect(303, request.redirectTo);
	} catch (error) {
		if (isRedirect(error)) throw error;

		logger.error({ err: error }, 'Failed to start admin OIDC login');
		const message =
			error instanceof Error ? error.message : 'OpenID Connect login could not be started.';
		redirect(303, `/admin/login?error=${encodeURIComponent(message)}`);
	}
};
