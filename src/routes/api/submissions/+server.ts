import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import { importEcdsaPublicKey, stringToJwk, verify } from '$lib/crypto';
import type { CreateSubmissionRequest, CreateSubmissionResponse } from '$lib/api-types';

/**
 * POST /api/submissions
 *
 * Accepts an encrypted submission from an authenticated SUBMITTER.
 * Verifies the ECDSA signature over (nonce_bytes || SHA-256(encryptedPayload_bytes))
 * using the challenge-response mechanism, then stores the ciphertext.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;

	if (typeof b.projectId !== 'string' || !b.projectId)
		throw error(400, 'projectId is required');
	if (typeof b.encryptedPayload !== 'string' || !b.encryptedPayload)
		throw error(400, 'encryptedPayload is required');
	if (typeof b.encryptedKeyProject !== 'string' || !b.encryptedKeyProject)
		throw error(400, 'encryptedKeyProject is required');
	if (typeof b.encryptedKeyUser !== 'string' || !b.encryptedKeyUser)
		throw error(400, 'encryptedKeyUser is required');
	if (typeof b.submitterSignature !== 'string' || !b.submitterSignature)
		throw error(400, 'submitterSignature is required');
	if (typeof b.nonce !== 'string' || !b.nonce)
		throw error(400, 'nonce is required');

	const { projectId, encryptedPayload, encryptedKeyProject, encryptedKeyUser, submitterSignature, nonce } =
		b as CreateSubmissionRequest;

	// Verify membership (any role can submit)
	const membership = await db.membership.findUnique({
		where: { userId_projectId: { userId: locals.user.id, projectId } }
	});
	if (!membership) throw error(403, 'Not a member of this project');

	// Validate and consume the nonce
	const challenge = await db.challenge.findUnique({ where: { nonce } });
	if (challenge) {
		await db.challenge.delete({ where: { nonce } }).catch(() => {});
	}
	if (!challenge || challenge.expiresAt < new Date()) {
		logger.warn({ userId: locals.user.id }, 'Submission rejected: invalid or expired nonce');
		throw error(401, 'Invalid or expired nonce');
	}

	// Verify ECDSA signature over (nonce_bytes || SHA-256(encryptedPayload_bytes))
	const nonceBytes = new TextEncoder().encode(nonce);
	const payloadBytes = new TextEncoder().encode(encryptedPayload);
	const sha256bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes));
	const message = new Uint8Array(nonceBytes.length + sha256bytes.length);
	message.set(nonceBytes);
	message.set(sha256bytes, nonceBytes.length);

	let valid: boolean;
	try {
		const publicKey = await importEcdsaPublicKey(stringToJwk(locals.user.signingPublicKey));
		valid = await verify(publicKey, submitterSignature, message);
	} catch {
		throw error(400, 'Signature verification failed');
	}

	if (!valid) {
		logger.warn({ userId: locals.user.id }, 'Submission rejected: invalid signature');
		throw error(400, 'Invalid signature');
	}

	// Store the submission
	const submission = await db.submission.create({
		data: {
			projectId,
			userId: locals.user.id,
			encryptedPayload,
			encryptedKeyProject,
			encryptedKeyUser,
			submitterSignature
		}
	});

	logger.info(
		{ submissionId: submission.id, projectId, userId: locals.user.id },
		'Submission received'
	);

	return json({ submissionId: submission.id } satisfies CreateSubmissionResponse, { status: 201 });
};

