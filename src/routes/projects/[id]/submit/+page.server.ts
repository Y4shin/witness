import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.member) redirect(303, `/auth?projectId=${params.id}&next=/projects/${params.id}/submit`);

	const project = await db.project.findUnique({ where: { id: params.id } });
	if (!project) throw error(404, 'Project not found');
	if (!project.publicKey) throw error(400, 'Project is not ready yet — no public key');

	const formFields = await db.formField.findMany({
		where: { projectId: params.id },
		orderBy: { sortOrder: 'asc' }
	});

	return {
		projectId: params.id,
		projectPublicKey: project.publicKey,
		formFields
	};
};
