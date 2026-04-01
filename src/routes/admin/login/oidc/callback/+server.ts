import { isRedirect, redirect, type Cookies } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	ADMIN_COOKIE_BASE,
	ADMIN_COOKIE_NAME,
	ADMIN_OIDC_CODE_VERIFIER_COOKIE_NAME,
	ADMIN_OIDC_COOKIE_BASE,
	ADMIN_OIDC_NONCE_COOKIE_NAME,
	ADMIN_OIDC_STATE_COOKIE_NAME,
	createAdminSession,
	finishAdminOidcLogin
} from '$lib/server/admin-auth';
import { logger } from '$lib/server/logger';

function clearOidcCookies(cookies: Cookies) {
	cookies.delete(ADMIN_OIDC_STATE_COOKIE_NAME, { path: ADMIN_OIDC_COOKIE_BASE.path });
	cookies.delete(ADMIN_OIDC_NONCE_COOKIE_NAME, { path: ADMIN_OIDC_COOKIE_BASE.path });
	cookies.delete(ADMIN_OIDC_CODE_VERIFIER_COOKIE_NAME, { path: ADMIN_OIDC_COOKIE_BASE.path });
}

export const GET: RequestHandler = async ({ cookies, url }) => {
	const oidcError = url.searchParams.get('error');
	if (oidcError) {
		clearOidcCookies(cookies);
		const description = url.searchParams.get('error_description');
		const message = description ? `${oidcError}: ${description}` : oidcError;
		redirect(303, `/admin/login?error=${encodeURIComponent(message)}`);
	}

	const code = url.searchParams.get('code');
	const returnedState = url.searchParams.get('state');
	const expectedState = cookies.get(ADMIN_OIDC_STATE_COOKIE_NAME);
	const expectedNonce = cookies.get(ADMIN_OIDC_NONCE_COOKIE_NAME);
	const codeVerifier = cookies.get(ADMIN_OIDC_CODE_VERIFIER_COOKIE_NAME);

	clearOidcCookies(cookies);

	if (!code || !returnedState || !expectedState || !expectedNonce || !codeVerifier) {
		redirect(
			303,
			'/admin/login?error=' +
				encodeURIComponent('The OpenID Connect login response was incomplete. Please try again.')
		);
	}

	try {
		const identity = await finishAdminOidcLogin({
			currentUrl: url,
			code,
			returnedState,
			expectedState,
			expectedNonce,
			codeVerifier
		});
		const token = createAdminSession(identity);
		const secure = url.protocol === 'https:';
		cookies.set(ADMIN_COOKIE_NAME, token, { ...ADMIN_COOKIE_BASE, secure });

		redirect(303, '/admin');
	} catch (error) {
		if (isRedirect(error)) throw error;

		logger.error({ err: error }, 'Failed to complete admin OIDC login');
		const message =
			error instanceof Error ? error.message : 'OpenID Connect login could not be completed.';
		redirect(303, `/admin/login?error=${encodeURIComponent(message)}`);
	}
};
