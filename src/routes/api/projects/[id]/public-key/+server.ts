import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { ProjectPublicKeyResponse } from '$lib/api-types';

export const GET: RequestHandler = async ({ params }) => {
	const project = await db.project.findUnique({ where: { id: params.id } });
	if (!project) throw error(404, 'Project not found');
	if (!project.publicKey) throw error(404, 'Project has no public key yet');
	return json({ publicKey: project.publicKey } satisfies ProjectPublicKeyResponse);
};
