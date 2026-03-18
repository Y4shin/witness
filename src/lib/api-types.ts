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

// ── Error shape (SvelteKit error() helper) ─────────────────────────────────

export interface ApiErrorBody {
	message: string;
}
