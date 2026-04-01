import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { logger } from '$lib/server/logger';

export const ADMIN_COOKIE_NAME = 'admin-session';
export const ADMIN_OIDC_STATE_COOKIE_NAME = 'admin-oidc-state';
export const ADMIN_OIDC_NONCE_COOKIE_NAME = 'admin-oidc-nonce';
export const ADMIN_OIDC_CODE_VERIFIER_COOKIE_NAME = 'admin-oidc-code-verifier';

type AdminAuthMode = 'password' | 'oidc';

type PasswordAdminAuthConfig = {
	mode: 'password';
	password: string;
};

type OidcAdminAuthConfig = {
	mode: 'oidc';
	discoveryUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	allowedEmails: string[];
	allowedSubjects: string[];
	allowedGroups: string[];
};

export type AdminAuthConfig = PasswordAdminAuthConfig | OidcAdminAuthConfig;

export type AdminIdentity = {
	source: AdminAuthMode;
	subject?: string;
	email?: string;
	name?: string;
};

type AdminSession = {
	expiresAt: number;
	identity: AdminIdentity;
};

type OidcDiscoveryDocument = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	userinfo_endpoint?: string;
	end_session_endpoint?: string;
};

type OidcTokenResponse = {
	access_token?: string;
	id_token?: string;
	token_type?: string;
};

type OidcUserInfo = {
	sub?: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	preferred_username?: string;
	groups?: string | string[];
};

type OidcAuthorizationRequest = {
	redirectTo: string;
	state: string;
	nonce: string;
	codeVerifier: string;
};

type OidcCallbackInput = {
	currentUrl: URL;
	code: string;
	returnedState: string;
	expectedState: string;
	expectedNonce: string;
	codeVerifier: string;
};

/** 8-hour admin session lifetime */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OIDC_FLOW_TTL_MS = 10 * 60;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

export const ADMIN_COOKIE_BASE = {
	httpOnly: true,
	sameSite: 'lax',
	path: '/admin',
	maxAge: SESSION_TTL_MS / 1000
} as const;

export const ADMIN_OIDC_COOKIE_BASE = {
	httpOnly: true,
	sameSite: 'lax',
	path: '/admin/login/oidc',
	maxAge: OIDC_FLOW_TTL_MS
} as const;

const activeSessions = new Map<string, AdminSession>();
const discoveryCache = new Map<
	string,
	{
		expiresAt: number;
		document: OidcDiscoveryDocument;
	}
>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const OIDC_ENV_KEYS = [
	'ADMIN_OIDC_DISCOVERY_URL',
	'ADMIN_OIDC_CLIENT_ID',
	'ADMIN_OIDC_CLIENT_SECRET',
	'ADMIN_OIDC_SCOPES',
	'ADMIN_OIDC_ALLOWED_EMAILS',
	'ADMIN_OIDC_ALLOWED_SUBJECTS',
	'ADMIN_OIDC_ALLOWED_GROUPS'
] as const;

export class AdminAuthConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdminAuthConfigError';
	}
}

export class AdminOidcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdminOidcError';
	}
}

/** Hashes a string with SHA-256 to enable constant-time comparison. */
function sha256(input: string): Buffer {
	return crypto.createHash('sha256').update(input).digest();
}

function isNonEmpty(value: string | undefined): value is string {
	return Boolean(value?.trim());
}

function parseCsv(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
}

function normalizeGroupsClaim(value: unknown): string[] {
	if (typeof value === 'string') {
		return value.trim() ? [value.trim()] : [];
	}

	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	return [];
}

function hasAnyOidcEnv(): boolean {
	return OIDC_ENV_KEYS.some((key) => isNonEmpty(env[key]));
}

function getConfiguredMode(): AdminAuthMode {
	const explicitMode = env.ADMIN_AUTH_MODE?.trim();

	if (explicitMode && explicitMode !== 'password' && explicitMode !== 'oidc') {
		throw new AdminAuthConfigError('ADMIN_AUTH_MODE must be either "password" or "oidc".');
	}

	const hasPassword = isNonEmpty(env.ADMIN_PASSWORD);
	const hasOidc = hasAnyOidcEnv();

	if (explicitMode === 'password') {
		if (hasOidc) {
			throw new AdminAuthConfigError(
				'Password admin auth cannot be combined with ADMIN_OIDC_* variables.'
			);
		}
		if (!hasPassword) {
			throw new AdminAuthConfigError(
				'ADMIN_PASSWORD is required when password admin auth is enabled.'
			);
		}
		return 'password';
	}

	if (explicitMode === 'oidc') {
		if (hasPassword) {
			throw new AdminAuthConfigError('OIDC admin auth cannot be combined with ADMIN_PASSWORD.');
		}
		return 'oidc';
	}

	if (hasPassword && hasOidc) {
		throw new AdminAuthConfigError(
			'ADMIN_PASSWORD and ADMIN_OIDC_* variables are mutually exclusive.'
		);
	}

	if (hasPassword) return 'password';
	if (hasOidc) return 'oidc';

	throw new AdminAuthConfigError(
		'Admin auth is not configured. Set ADMIN_PASSWORD or the ADMIN_OIDC_* variables.'
	);
}

export function getAdminAuthConfig(): AdminAuthConfig {
	const mode = getConfiguredMode();

	if (mode === 'password') {
		return {
			mode,
			password: env.ADMIN_PASSWORD!.trim()
		};
	}

	const requiredKeys = [
		'ADMIN_OIDC_DISCOVERY_URL',
		'ADMIN_OIDC_CLIENT_ID',
		'ADMIN_OIDC_CLIENT_SECRET'
	] as const;
	const missingKeys = requiredKeys.filter((key) => !isNonEmpty(env[key]));

	if (missingKeys.length > 0) {
		throw new AdminAuthConfigError(
			`OIDC admin auth is missing required variables: ${missingKeys.join(', ')}.`
		);
	}

	const allowedEmails = parseCsv(env.ADMIN_OIDC_ALLOWED_EMAILS).map((value) => value.toLowerCase());
	const allowedSubjects = parseCsv(env.ADMIN_OIDC_ALLOWED_SUBJECTS);
	const allowedGroups = parseCsv(env.ADMIN_OIDC_ALLOWED_GROUPS);

	if (allowedEmails.length === 0 && allowedSubjects.length === 0 && allowedGroups.length === 0) {
		throw new AdminAuthConfigError(
			'OIDC admin auth requires ADMIN_OIDC_ALLOWED_EMAILS, ADMIN_OIDC_ALLOWED_SUBJECTS, or ADMIN_OIDC_ALLOWED_GROUPS.'
		);
	}

	return {
		mode,
		discoveryUrl: env.ADMIN_OIDC_DISCOVERY_URL!.trim(),
		clientId: env.ADMIN_OIDC_CLIENT_ID!.trim(),
		clientSecret: env.ADMIN_OIDC_CLIENT_SECRET!.trim(),
		scopes: env.ADMIN_OIDC_SCOPES?.trim() || 'openid profile email',
		allowedEmails,
		allowedSubjects,
		allowedGroups
	};
}

function assertPasswordConfig(config: AdminAuthConfig): PasswordAdminAuthConfig {
	if (config.mode !== 'password') {
		throw new AdminAuthConfigError('Password admin auth is not enabled.');
	}
	return config;
}

function assertOidcConfig(config: AdminAuthConfig): OidcAdminAuthConfig {
	if (config.mode !== 'oidc') {
		throw new AdminAuthConfigError('OIDC admin auth is not enabled.');
	}
	return config;
}

function bufferToBase64Url(buffer: Buffer): string {
	return buffer.toString('base64url');
}

function getAdminOidcRedirectUri(currentUrl: URL): string {
	return new URL('/admin/login/oidc/callback', currentUrl).toString();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new AdminOidcError(
			`OIDC request to ${url} failed with ${response.status}${body ? `: ${body}` : ''}`
		);
	}
	return (await response.json()) as T;
}

async function getOidcDiscovery(discoveryUrl: string): Promise<OidcDiscoveryDocument> {
	const cached = discoveryCache.get(discoveryUrl);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.document;
	}

	const normalizedUrl = discoveryUrl.endsWith('/.well-known/openid-configuration')
		? discoveryUrl
		: `${discoveryUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;

	const document = await fetchJson<OidcDiscoveryDocument>(normalizedUrl);
	discoveryCache.set(discoveryUrl, {
		document,
		expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS
	});
	return document;
}

function getRemoteJwksSet(jwksUri: string) {
	let jwks = jwksCache.get(jwksUri);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(jwksUri));
		jwksCache.set(jwksUri, jwks);
	}
	return jwks;
}

async function exchangeAuthorizationCode(
	config: OidcAdminAuthConfig,
	discovery: OidcDiscoveryDocument,
	code: string,
	redirectUri: string,
	codeVerifier: string
): Promise<OidcTokenResponse> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: config.clientId,
		client_secret: config.clientSecret,
		code_verifier: codeVerifier
	});

	return fetchJson<OidcTokenResponse>(discovery.token_endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded'
		},
		body
	});
}

function normalizeIdentity(
	payload: Record<string, unknown>,
	userInfo?: OidcUserInfo
): AdminIdentity & { emailVerified: boolean; subject: string; groups: string[] } {
	const email =
		typeof userInfo?.email === 'string'
			? userInfo.email
			: typeof payload.email === 'string'
				? payload.email
				: undefined;
	const name =
		typeof userInfo?.name === 'string'
			? userInfo.name
			: typeof payload.name === 'string'
				? payload.name
				: typeof userInfo?.preferred_username === 'string'
					? userInfo.preferred_username
					: typeof payload.preferred_username === 'string'
						? payload.preferred_username
						: undefined;
	const emailVerified =
		typeof userInfo?.email_verified === 'boolean'
			? userInfo.email_verified
			: payload.email_verified !== false;
	const groups = [
		...normalizeGroupsClaim(payload.groups),
		...normalizeGroupsClaim(userInfo?.groups)
	];

	return {
		source: 'oidc',
		subject: String(payload.sub),
		email: email?.toLowerCase(),
		name,
		emailVerified,
		groups: [...new Set(groups)]
	};
}

async function fetchUserInfo(
	discovery: OidcDiscoveryDocument,
	accessToken: string | undefined
): Promise<OidcUserInfo | undefined> {
	if (!discovery.userinfo_endpoint || !accessToken) {
		return undefined;
	}

	return fetchJson<OidcUserInfo>(discovery.userinfo_endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`
		}
	});
}

function assertAuthorizedOidcIdentity(
	config: OidcAdminAuthConfig,
	identity: AdminIdentity & { emailVerified: boolean; subject: string; groups: string[] }
): AdminIdentity {
	const allowedBySubject =
		config.allowedSubjects.length > 0 && config.allowedSubjects.includes(identity.subject);
	const allowedByEmail =
		Boolean(identity.email) && config.allowedEmails.includes(identity.email!.toLowerCase());
	const allowedByGroup =
		config.allowedGroups.length > 0 &&
		identity.groups.some((group) => config.allowedGroups.includes(group));

	if (!allowedBySubject && !allowedByEmail && !allowedByGroup) {
		throw new AdminOidcError(
			'The authenticated account is not allowed to access the admin console.'
		);
	}

	if (allowedByEmail && !identity.emailVerified && !allowedBySubject && !allowedByGroup) {
		throw new AdminOidcError('The authenticated account email address is not verified.');
	}

	return {
		source: 'oidc',
		subject: identity.subject,
		email: identity.email,
		name: identity.name
	};
}

/** Returns the resolved admin auth mode. Throws when config is invalid. */
export function getAdminAuthMode(): AdminAuthMode {
	return getAdminAuthConfig().mode;
}

/** Returns true if password admin auth is configured in the environment. */
export function isAdminPasswordConfigured(): boolean {
	return getAdminAuthMode() === 'password';
}

/**
 * Constant-time password check against the ADMIN_PASSWORD env variable.
 * Returns false when password auth is not enabled.
 */
export function verifyAdminPassword(input: string): boolean {
	const config = getAdminAuthConfig();
	if (config.mode !== 'password') return false;
	return crypto.timingSafeEqual(sha256(input), sha256(assertPasswordConfig(config).password));
}

/** Creates a new admin session and returns the opaque token. */
export function createAdminSession(identity: AdminIdentity = { source: 'password' }): string {
	const token = crypto.randomBytes(32).toString('base64url');
	activeSessions.set(token, { identity, expiresAt: Date.now() + SESSION_TTL_MS });
	logger.info(
		{ source: identity.source, subject: identity.subject, email: identity.email },
		'Admin session created'
	);
	return token;
}

/** Returns the session metadata for a live admin session, otherwise null. */
export function getAdminSession(token: string | undefined): AdminSession | null {
	if (!token) return null;
	const session = activeSessions.get(token);
	if (!session) return null;
	if (Date.now() > session.expiresAt) {
		activeSessions.delete(token);
		return null;
	}
	return session;
}

/** Returns true if the token maps to a live admin session. */
export function validateAdminSession(token: string | undefined): boolean {
	return getAdminSession(token) !== null;
}

/** Removes an admin session (logout). */
export function revokeAdminSession(token: string): void {
	const session = activeSessions.get(token);
	activeSessions.delete(token);
	logger.info(
		{
			source: session?.identity.source,
			subject: session?.identity.subject,
			email: session?.identity.email
		},
		'Admin session revoked'
	);
}

export async function createAdminOidcAuthorizationRequest(
	currentUrl: URL
): Promise<OidcAuthorizationRequest> {
	const config = assertOidcConfig(getAdminAuthConfig());
	const discovery = await getOidcDiscovery(config.discoveryUrl);

	const state = crypto.randomBytes(32).toString('base64url');
	const nonce = crypto.randomBytes(32).toString('base64url');
	const codeVerifier = crypto.randomBytes(32).toString('base64url');
	const codeChallenge = bufferToBase64Url(
		crypto.createHash('sha256').update(codeVerifier).digest()
	);

	const redirectUri = getAdminOidcRedirectUri(currentUrl);
	const redirectTo = new URL(discovery.authorization_endpoint);
	redirectTo.searchParams.set('client_id', config.clientId);
	redirectTo.searchParams.set('response_type', 'code');
	redirectTo.searchParams.set('redirect_uri', redirectUri);
	redirectTo.searchParams.set('scope', config.scopes);
	redirectTo.searchParams.set('state', state);
	redirectTo.searchParams.set('nonce', nonce);
	redirectTo.searchParams.set('code_challenge', codeChallenge);
	redirectTo.searchParams.set('code_challenge_method', 'S256');

	return {
		redirectTo: redirectTo.toString(),
		state,
		nonce,
		codeVerifier
	};
}

export async function finishAdminOidcLogin(input: OidcCallbackInput): Promise<AdminIdentity> {
	const config = assertOidcConfig(getAdminAuthConfig());
	const discovery = await getOidcDiscovery(config.discoveryUrl);

	if (input.returnedState !== input.expectedState) {
		throw new AdminOidcError('The OpenID Connect login state did not match. Please try again.');
	}

	const redirectUri = getAdminOidcRedirectUri(input.currentUrl);
	const tokenResponse = await exchangeAuthorizationCode(
		config,
		discovery,
		input.code,
		redirectUri,
		input.codeVerifier
	);

	if (!tokenResponse.id_token) {
		throw new AdminOidcError('The identity provider did not return an ID token.');
	}

	const jwks = getRemoteJwksSet(discovery.jwks_uri);
	const { payload } = await jwtVerify(tokenResponse.id_token, jwks, {
		issuer: discovery.issuer,
		audience: config.clientId
	});

	if (typeof payload.sub !== 'string' || !payload.sub) {
		throw new AdminOidcError('The ID token is missing a subject claim.');
	}

	if (typeof payload.nonce !== 'string' || payload.nonce !== input.expectedNonce) {
		throw new AdminOidcError('The ID token nonce did not match. Please try again.');
	}

	const userInfo = await fetchUserInfo(discovery, tokenResponse.access_token);
	const normalizedIdentity = normalizeIdentity(payload, userInfo);
	return assertAuthorizedOidcIdentity(config, normalizedIdentity);
}
