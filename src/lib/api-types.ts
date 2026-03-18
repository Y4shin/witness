/**
 * Shared request/response shapes for all API endpoints.
 *
 * Server handlers use `satisfies` against these types so TypeScript catches
 * shape mismatches at build time. Client callers cast to these types via the
 * typed api() wrapper in $lib/client/api.ts.
 */

// ── POST /api/users ───────────────────────────────────────────────────────

export interface RegisterRequest {
	signingPublicKey: string;
	encryptionPublicKey: string;
	encryptedName: string;
	encryptedContact: string;
}

export interface RegisterResponse {
	userId: string;
}

// ── GET /api/auth/challenge ────────────────────────────────────────────────

export interface ChallengeResponse {
	nonce: string;
}

// ── POST /api/auth/verify ─────────────────────────────────────────────────

export interface VerifyRequest {
	signingPublicKey: string;
	nonce: string;
	signature: string;
}

export interface VerifyResponse {
	ok: boolean;
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────

export interface LogoutResponse {
	ok: boolean;
}

// ── GET /api/projects/[id]/public-key ─────────────────────────────────────

export interface ProjectPublicKeyResponse {
	publicKey: string;
}

// ── PATCH /api/projects/[id]/public-key ───────────────────────────────────

export interface SetProjectPublicKeyRequest {
	publicKey: string;
}

// ── POST /api/memberships ─────────────────────────────────────────────────

export interface JoinProjectRequest {
	inviteToken: string;
	/** ECDH private key encrypted with the user's own ECDH public key.
	 *  Required for the first observer to initialise the project keypair. */
	encryptedProjectPrivateKey?: string | null;
}

export interface JoinProjectResponse {
	projectId: string;
	role: 'SUBMITTER' | 'OBSERVER';
}

// ── GET /api/invites/[token] ───────────────────────────────────────────────

export interface InviteInfoResponse {
	projectId: string;
	projectName: string;
	role: 'SUBMITTER' | 'OBSERVER';
}

// ── POST /api/invites ──────────────────────────────────────────────────────

export interface CreateInviteRequest {
	projectId: string;
	role: 'SUBMITTER' | 'OBSERVER';
	maxUses?: number | null;
	expiresAt?: string | null; // ISO-8601 date string
}

export interface CreateInviteResponse {
	token: string;
}

// ── POST /api/submissions ─────────────────────────────────────────────────

/**
 * Serialised form of an ECDH-wrapped symmetric key.
 * Stored as JSON string in the DB.
 */
export interface SubmissionKeyBundle {
	ephemeralPublicKey: JsonWebKey;
	wrappedKey: string; // base64url(salt || iv || wrappedKey+tag)
}

export interface CreateSubmissionRequest {
	projectId: string;
	encryptedPayload: string;    // base64url AES-GCM ciphertext
	encryptedKeyProject: string; // JSON-serialised SubmissionKeyBundle
	encryptedKeyUser: string;    // JSON-serialised SubmissionKeyBundle
	submitterSignature: string;  // base64url ECDSA signature
	nonce: string;               // single-use challenge nonce
}

export interface CreateSubmissionResponse {
	submissionId: string;
}

// ── FormField ─────────────────────────────────────────────────────────────

export type FieldType = 'TEXT' | 'SELECT' | 'FILE';

/** Raw shape returned by the server. `options` is a JSON string for SELECT, null otherwise. */
export interface FormField {
	id: string;
	projectId: string;
	label: string;
	type: FieldType;
	options: string | null; // JSON-encoded string[], e.g. '["A","B"]'
	required: boolean;
	sortOrder: number;
	createdAt: string; // ISO-8601
}

// ── GET /api/projects/[id]/fields ─────────────────────────────────────────

export interface GetFieldsResponse {
	fields: FormField[];
}

// ── POST /api/projects/[id]/fields ────────────────────────────────────────

export interface CreateFieldRequest {
	label: string;
	type: FieldType;
	options?: string[] | null; // parsed array; server will JSON.stringify
	required?: boolean;
	sortOrder?: number;
}

export interface CreateFieldResponse {
	field: FormField;
}

// ── PATCH /api/projects/[id]/fields/[fieldId] ─────────────────────────────

export interface PatchFieldRequest {
	sortOrder: number;
}

export interface PatchFieldResponse {
	field: FormField;
}

// ── Error shape (SvelteKit error() helper) ─────────────────────────────────

export interface ApiErrorBody {
	message: string;
}
