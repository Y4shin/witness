import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);
const mockJwtVerify = vi.hoisted(() => vi.fn());
const mockCreateRemoteJwkSet = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));
vi.mock('jose', () => ({
	createRemoteJWKSet: mockCreateRemoteJwkSet,
	jwtVerify: mockJwtVerify
}));

import {
	AdminAuthConfigError,
	AdminOidcError,
	createAdminOidcAuthorizationRequest,
	createAdminSession,
	finishAdminOidcLogin,
	getAdminAuthConfig,
	revokeAdminSession,
	validateAdminSession
} from './admin-auth';

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('admin auth', () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		for (const key of Object.keys(mockEnv)) delete mockEnv[key];
		mockJwtVerify.mockReset();
		mockCreateRemoteJwkSet.mockClear();
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses password mode when ADMIN_PASSWORD is configured', () => {
		mockEnv.ADMIN_PASSWORD = 'super-secret-password';

		expect(getAdminAuthConfig()).toEqual({
			mode: 'password',
			password: 'super-secret-password'
		});
	});

	it('rejects mixed password and oidc configuration', () => {
		mockEnv.ADMIN_PASSWORD = 'super-secret-password';
		mockEnv.ADMIN_OIDC_DISCOVERY_URL = 'https://auth.example/application/o/reporting-tool/';
		mockEnv.ADMIN_OIDC_CLIENT_ID = 'reporting-tool';
		mockEnv.ADMIN_OIDC_CLIENT_SECRET = 'secret';
		mockEnv.ADMIN_OIDC_ALLOWED_EMAILS = 'admin@example.com';

		expect(() => getAdminAuthConfig()).toThrow(AdminAuthConfigError);
	});

	it('requires an allow-list in oidc mode', () => {
		mockEnv.ADMIN_AUTH_MODE = 'oidc';
		mockEnv.ADMIN_OIDC_DISCOVERY_URL = 'https://auth.example/application/o/reporting-tool/';
		mockEnv.ADMIN_OIDC_CLIENT_ID = 'reporting-tool';
		mockEnv.ADMIN_OIDC_CLIENT_SECRET = 'secret';

		expect(() => getAdminAuthConfig()).toThrow(
			'OIDC admin auth requires ADMIN_OIDC_ALLOWED_EMAILS or ADMIN_OIDC_ALLOWED_SUBJECTS.'
		);
	});

	it('creates and revokes admin sessions', () => {
		const token = createAdminSession({ source: 'password' });

		expect(validateAdminSession(token)).toBe(true);

		revokeAdminSession(token);
		expect(validateAdminSession(token)).toBe(false);
	});

	it('builds an oidc authorization request with PKCE', async () => {
		mockEnv.ADMIN_AUTH_MODE = 'oidc';
		mockEnv.ADMIN_OIDC_DISCOVERY_URL = 'https://auth-one.example/application/o/reporting-tool/';
		mockEnv.ADMIN_OIDC_CLIENT_ID = 'reporting-tool';
		mockEnv.ADMIN_OIDC_CLIENT_SECRET = 'secret';
		mockEnv.ADMIN_OIDC_ALLOWED_EMAILS = 'admin@example.com';

		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				issuer: 'https://auth-one.example/application/o/reporting-tool/',
				authorization_endpoint: 'https://auth-one.example/application/o/reporting-tool/authorize',
				token_endpoint: 'https://auth-one.example/application/o/reporting-tool/token',
				jwks_uri: 'https://auth-one.example/application/o/reporting-tool/jwks/'
			})
		);

		const request = await createAdminOidcAuthorizationRequest(
			new URL('http://localhost:3000/admin/login')
		);
		const redirectUrl = new URL(request.redirectTo);

		expect(redirectUrl.origin).toBe('https://auth-one.example');
		expect(redirectUrl.searchParams.get('client_id')).toBe('reporting-tool');
		expect(redirectUrl.searchParams.get('response_type')).toBe('code');
		expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
			'http://localhost:3000/admin/login/oidc/callback'
		);
		expect(redirectUrl.searchParams.get('scope')).toBe('openid profile email');
		expect(redirectUrl.searchParams.get('state')).toBe(request.state);
		expect(redirectUrl.searchParams.get('nonce')).toBe(request.nonce);
		expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(request.codeVerifier.length).toBeGreaterThan(10);
	});

	it('completes oidc login for an allowed email address', async () => {
		mockEnv.ADMIN_AUTH_MODE = 'oidc';
		mockEnv.ADMIN_OIDC_DISCOVERY_URL = 'https://auth-two.example/application/o/reporting-tool/';
		mockEnv.ADMIN_OIDC_CLIENT_ID = 'reporting-tool';
		mockEnv.ADMIN_OIDC_CLIENT_SECRET = 'secret';
		mockEnv.ADMIN_OIDC_ALLOWED_EMAILS = 'admin@example.com';

		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					issuer: 'https://auth-two.example/application/o/reporting-tool/',
					authorization_endpoint: 'https://auth-two.example/application/o/reporting-tool/authorize',
					token_endpoint: 'https://auth-two.example/application/o/reporting-tool/token',
					jwks_uri: 'https://auth-two.example/application/o/reporting-tool/jwks/'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					id_token: 'header.payload.signature',
					access_token: 'access-token'
				})
			);

		mockJwtVerify.mockResolvedValueOnce({
			payload: {
				sub: 'user-1',
				nonce: 'expected-nonce',
				email: 'admin@example.com',
				email_verified: true,
				name: 'Admin User'
			}
		});

		const identity = await finishAdminOidcLogin({
			currentUrl: new URL('http://localhost:3000/admin/login/oidc/callback?code=abc&state=state-1'),
			code: 'abc',
			returnedState: 'state-1',
			expectedState: 'state-1',
			expectedNonce: 'expected-nonce',
			codeVerifier: 'verifier-1'
		});

		expect(identity).toEqual({
			source: 'oidc',
			subject: 'user-1',
			email: 'admin@example.com',
			name: 'Admin User'
		});
	});

	it('rejects oidc login for an unauthorized identity', async () => {
		mockEnv.ADMIN_AUTH_MODE = 'oidc';
		mockEnv.ADMIN_OIDC_DISCOVERY_URL = 'https://auth-three.example/application/o/reporting-tool/';
		mockEnv.ADMIN_OIDC_CLIENT_ID = 'reporting-tool';
		mockEnv.ADMIN_OIDC_CLIENT_SECRET = 'secret';
		mockEnv.ADMIN_OIDC_ALLOWED_EMAILS = 'admin@example.com';

		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					issuer: 'https://auth-three.example/application/o/reporting-tool/',
					authorization_endpoint:
						'https://auth-three.example/application/o/reporting-tool/authorize',
					token_endpoint: 'https://auth-three.example/application/o/reporting-tool/token',
					jwks_uri: 'https://auth-three.example/application/o/reporting-tool/jwks/'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					id_token: 'header.payload.signature'
				})
			);

		mockJwtVerify.mockResolvedValueOnce({
			payload: {
				sub: 'user-2',
				nonce: 'expected-nonce',
				email: 'outsider@example.com',
				email_verified: true
			}
		});

		await expect(
			finishAdminOidcLogin({
				currentUrl: new URL(
					'http://localhost:3000/admin/login/oidc/callback?code=abc&state=state-2'
				),
				code: 'abc',
				returnedState: 'state-2',
				expectedState: 'state-2',
				expectedNonce: 'expected-nonce',
				codeVerifier: 'verifier-2'
			})
		).rejects.toBeInstanceOf(AdminOidcError);
	});
});
