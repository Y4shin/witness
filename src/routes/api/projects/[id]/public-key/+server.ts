import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logger } from '$lib/server/logger';
import type { ProjectPublicKeyResponse } from '$lib/api-types';

export const GET: RequestHandler = async ({ params }) => {
	const project = await db.project.findUnique({ where: { id: params.id } });
	if (!project) throw error(404, 'Project not found');
	if (!project.publicKey) throw error(404, 'Project has no public key yet');
	return json({ publicKey: project.publicKey } satisfies ProjectPublicKeyResponse);
};

/**
 * PATCH /api/projects/[id]/public-key
 * Sets the project ECDH public key for the first time (keypair genesis).
 * Returns 409 if the project already has a public key.
 * Requires an authenticated session.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.member) throw error(401, 'Authentication required');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const b = body as Record<string, unknown>;
	if (typeof b.publicKey !== 'string' || !b.publicKey) {
		throw error(400, 'publicKey is required');
	}

	const project = await db.project.findUnique({ where: { id: params.id } });
	if (!project) throw error(404, 'Project not found');
	if (project.publicKey) throw error(409, 'Project already has a public key');

	await db.project.update({ where: { id: params.id }, data: { publicKey: b.publicKey } });

	logger.info({ projectId: params.id, memberId: locals.member.id }, 'Project public key set');

	return json({ publicKey: b.publicKey } satisfies ProjectPublicKeyResponse);
};
