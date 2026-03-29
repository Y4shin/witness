/**
 * Typed API client for all server endpoints.
 * Throws ApiError on non-2xx responses with the server's error message.
 */
import type {
	ChallengeResponse,
	VerifyRequest,
	VerifyResponse,
	LogoutResponse,
	ProjectPublicKeyResponse,
	SetProjectPublicKeyRequest,
	JoinProjectRequest,
	JoinProjectResponse,
	InviteInfoResponse,
	CreateInviteRequest,
	CreateInviteResponse,
	GetProjectInvitesResponse,
	RevokeInviteResponse,
	CreateSubmissionRequest,
	CreateSubmissionResponse,
	GetSubmissionsResponse,
	UploadFileRequest,
	UploadFileResponse,
	GetFilesResponse,
	GetMembersResponse,
	PromoteRequest,
	PromoteResponse,
	GetFieldsResponse,
	CreateFieldRequest,
	CreateFieldResponse,
	PatchFieldRequest,
	PatchFieldResponse,
	ArchiveRequest,
	ArchiveResponse,
	MigrateSubmissionRequest,
	MigrateFileRequest,
	MigrateResponse
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

	projects: {
		getPublicKey: (projectId: string): Promise<ProjectPublicKeyResponse> =>
			call(`/api/projects/${projectId}/public-key`),

		setPublicKey: (projectId: string, body: SetProjectPublicKeyRequest): Promise<ProjectPublicKeyResponse> =>
			call(`/api/projects/${projectId}/public-key`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			})
	},

	memberships: {
		join: (body: JoinProjectRequest): Promise<JoinProjectResponse> =>
			post('/api/memberships', body)
	},

	invites: {
		getInfo: (token: string): Promise<InviteInfoResponse> =>
			call(`/api/invites/${token}`),

		create: (body: CreateInviteRequest): Promise<CreateInviteResponse> =>
			post('/api/invites', body),

		listForProject: (projectId: string): Promise<GetProjectInvitesResponse> =>
			call(`/api/projects/${projectId}/invites`),

		revoke: (token: string): Promise<RevokeInviteResponse> =>
			call(`/api/invites/${token}`, { method: 'DELETE' })
	},

	archive: {
		proxy: (body: ArchiveRequest): Promise<ArchiveResponse> =>
			post('/api/archive', body)
	},

	submissions: {
		create: (body: CreateSubmissionRequest): Promise<CreateSubmissionResponse> =>
			post('/api/submissions', body),

		list: (projectId: string): Promise<GetSubmissionsResponse> =>
			call(`/api/projects/${projectId}/submissions`),

		uploadFile: (submissionId: string, body: UploadFileRequest): Promise<UploadFileResponse> =>
			post(`/api/submissions/${submissionId}/files`, body),

		migrate: (submissionId: string, body: MigrateSubmissionRequest): Promise<MigrateResponse> =>
			call(`/api/submissions/${submissionId}/migrate`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			})
	},

	files: {
		/** Moderator-only: returns file records with encrypted keys for a submission. */
		list: (submissionId: string): Promise<GetFilesResponse> =>
			call(`/api/submissions/${submissionId}/files`),

		migrate: (submissionId: string, fileId: string, body: MigrateFileRequest): Promise<MigrateResponse> =>
			call(`/api/submissions/${submissionId}/files/${fileId}/migrate`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),

		/** Moderator-only: returns the raw encrypted bytes of a file plus the URL and a cloned Response for caching. */
		downloadEncrypted: async (
			submissionId: string,
			fileId: string
		): Promise<{ bytes: Uint8Array; url: string; response: Response }> => {
			const url = `/api/submissions/${submissionId}/files/${fileId}`;
			const res = await fetch(url);
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { message?: string };
				throw new ApiError(res.status, data.message ?? `HTTP ${res.status}`);
			}
			const clone = res.clone();
			const bytes = new Uint8Array(await res.arrayBuffer());
			return { bytes, url, response: clone };
		}
	},

	members: {
		list: (projectId: string): Promise<GetMembersResponse> =>
			call(`/api/projects/${projectId}/members`),

		promote: (projectId: string, body: PromoteRequest): Promise<PromoteResponse> =>
			post(`/api/projects/${projectId}/promote`, body)
	},

	fields: {
		list: (projectId: string): Promise<GetFieldsResponse> =>
			call(`/api/projects/${projectId}/fields`),

		create: (projectId: string, body: CreateFieldRequest): Promise<CreateFieldResponse> =>
			post(`/api/projects/${projectId}/fields`, body),

		reorder: (projectId: string, fieldId: string, body: PatchFieldRequest): Promise<PatchFieldResponse> =>
			call(`/api/projects/${projectId}/fields/${fieldId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),

		delete: (projectId: string, fieldId: string): Promise<{ ok: boolean }> =>
			call(`/api/projects/${projectId}/fields/${fieldId}`, { method: 'DELETE' })
	}
};
