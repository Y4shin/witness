/**
 * Typed API client for all server endpoints.
 * Throws ApiError on non-2xx responses with the server's error message.
 */
import type {
	ChallengeResponse,
	VerifyRequest,
	VerifyResponse,
	LogoutResponse,
	RegisterRequest,
	RegisterResponse,
	ProjectPublicKeyResponse
} from '$lib/api-types';

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

async function call<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
	const res = await fetch(input, init);
	const data = await res.json().catch(() => ({})) as { message?: string };
	if (!res.ok) throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
	return data as T;
}

function post<B, T>(url: string, body: B): Promise<T> {
	return call<T>(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

export const api = {
	auth: {
		challenge: (): Promise<ChallengeResponse> =>
			call('/api/auth/challenge'),

		verify: (body: VerifyRequest): Promise<VerifyResponse> =>
			post('/api/auth/verify', body),

		logout: (): Promise<LogoutResponse> =>
			post('/api/auth/logout', {})
	},

	users: {
		register: (body: RegisterRequest): Promise<RegisterResponse> =>
			post('/api/users', body)
	},

	projects: {
		getPublicKey: (projectId: string): Promise<ProjectPublicKeyResponse> =>
			call(`/api/projects/${projectId}/public-key`)
	}
};
