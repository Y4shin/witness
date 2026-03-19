import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';

export const load: LayoutServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(303, `/auth?next=/projects/${params.id}`);

	const [project, membership] = await Promise.all([
		db.project.findUnique({ where: { id: params.id }, select: { name: true } }),
		db.membership.findUnique({
			where: { userId_projectId: { userId: locals.user.id, projectId: params.id } }
		})
	]);

	if (!project) throw error(404, 'Project not found');
	if (!membership) throw error(403, 'Not a member of this project');

	return {
		projectId: params.id,
		projectName: project.name,
		role: membership.role as 'SUBMITTER' | 'MODERATOR'
	};
};
